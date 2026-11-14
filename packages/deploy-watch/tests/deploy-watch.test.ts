import { describe, expect, it } from "vitest";

import {
  CHECK_SPACING_MS,
  CHUNK_RETRY_KEY,
  createDeployWatch,
  isChunkLoadError,
  LOOP_GUARD_MS,
  parseBuildFile,
  RELOADED_FOR_KEY,
} from "../src/index.js";
import type {
  BuildFile,
  DeployWatchDeps,
  NavigationEvent,
} from "../src/index.js";

const memoryStorage = (entries: Record<string, string> = {}) => {
  const values = new Map(Object.entries(entries));

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

type Answer = string | BuildFile | null | Error;

/** Whether an answer is a bare build id rather than a whole build file. */
const isBareId = (value: Answer): value is string => typeof value === "string";

/** The answer as a request settles it: a rejected promise for a request that failed. */
const settled = (value: Answer): Promise<BuildFile | null> =>
  value instanceof Error
    ? Promise.reject(value)
    : Promise.resolve(isBareId(value) ? { id: value } : value);

/** A `fetchLive` that always answers with `file`, and counts nothing. */
const answering = (file: BuildFile) => () => Promise.resolve(file);

// When each test's tab loads its page.
const LOADED_AT = 1_000_000;

/** A loop guard for `id`, as the tab writes it `ago` milliseconds before its page loads. */
const guard = (id: string, ago = 0) =>
  JSON.stringify({ id, at: LOADED_AT - ago });

/** What the stand-in tab's `/build.json` and its build's own copy answer. */
interface TabOptions {
  live?: Answer;
  /** Left out, the tab has no copy of its own build to read. */
  own?: Answer;
  storage?: ReturnType<typeof memoryStorage>;
}

/**
 * A tab on build `a`, whose `/build.json` answers `live` (a bare id is a file with only the id),
 * whose build's own copy answers `own` (left out, the tab has none to read), and whose clock the
 * test moves.
 */
const tab = ({
  live = "a",
  own,
  storage = memoryStorage(),
}: TabOptions = {}) => {
  let time = LOADED_AT;
  const loads: (string | undefined)[] = [];
  const state = { live, own, fetches: 0, ownFetches: 0 };

  const watch = createDeployWatch({
    current: "a",
    fetchLive: () => {
      state.fetches += 1;

      return settled(state.live);
    },
    fetchOwn:
      own === undefined
        ? undefined
        : () => {
            state.ownFetches += 1;

            return settled(state.own ?? null);
          },
    now: () => time,
    storage,
    load: (href) => {
      loads.push(href);
    },
  });

  return {
    watch,
    state,
    loads,
    storage,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

/** A chunk of code that did not load, in Chromium's words. */
const CHUNK = new TypeError(
  "Failed to fetch dynamically imported module: /assets/x.js"
);

/** What a check answered, and how many times the tab had read the live file by then. */
const checked = async (
  checking: Promise<boolean>,
  state: { fetches: number }
) => ({ isNew: await checking, fetches: state.fetches });

/** What a retry reads for a tab whose last check got `live` as its answer. */
const retriedAfterACheck = async (live: Answer) => {
  const { watch, state, advance } = tab({ live });
  advance(CHECK_SPACING_MS);
  await watch.check();
  advance(5000);

  return { isNew: await watch.check({ retry: true }), fetches: state.fetches };
};

/** What a tab whose build's own copy answers `own` reads over a deploy and the one after it. */
const afterADeploy = async (own: Answer) => {
  const { watch, state, advance } = tab({
    live: { id: "b", client: "c1" },
    own,
  });

  const isNew = await watch.check({ force: true });
  const changed = watch.changes("inbox");
  state.live = { id: "c", client: "c1" };
  advance(CHECK_SPACING_MS);
  await watch.check();

  return {
    isNew,
    changed,
    fetches: state.fetches,
    ownFetches: state.ownFetches,
  };
};

/**
 * What a tab replaced by build `b`, with `storage` as its session storage, does for an error
 * screen's missing chunk, and then at a move to another page.
 */
const replacedWithStorage = async (storage: DeployWatchDeps["storage"]) => {
  const loads: (string | undefined)[] = [];

  const watch = createDeployWatch({
    current: "a",
    fetchLive: answering({ id: "b" }),
    now: () => 0,
    storage,
    load: (href) => {
      loads.push(href);
    },
  });

  const recovers = await watch.recover(CHUNK);

  const forTheError = {
    recovers,
    reloading: watch.isReloading(),
    loads: [...loads],
  };

  watch.beforeNavigate(
    { subscribe: () => () => {}, history: {} },
    { fromLocation: {}, pathChanged: true }
  );

  return { forTheError, loadsAtTheMove: loads };
};

describe(createDeployWatch, () => {
  it("a tab's own activity checks at most once a minute; a failed chunk checks at once", async () => {
    const { watch, state, advance } = tab();
    // The page has just loaded its build.
    await expect(checked(watch.check(), state)).resolves.toStrictEqual({
      isNew: false,
      fetches: 0,
    });
    advance(CHECK_SPACING_MS);
    await expect(checked(watch.check(), state)).resolves.toStrictEqual({
      isNew: false,
      fetches: 1,
    });
    advance(5000);
    await expect(checked(watch.check(), state)).resolves.toStrictEqual({
      isNew: false,
      fetches: 1,
    });
    await expect(
      checked(watch.check({ force: true }), state)
    ).resolves.toStrictEqual({ isNew: false, fetches: 2 });
  });

  it("back online, a tab checks at once if its last check got no answer", async () => {
    const { watch, state, advance } = tab({ live: new Error("offline") });
    advance(CHECK_SPACING_MS);
    await expect(checked(watch.check(), state)).resolves.toStrictEqual({
      isNew: false,
      fetches: 1,
    });
    // Back online seconds later, with a deploy live meanwhile; a burst of events shares one request.
    state.live = "b";
    advance(5000);
    await expect(
      Promise.all([watch.check({ retry: true }), watch.check({ retry: true })])
    ).resolves.toStrictEqual([true, true]);
    expect(state.fetches).toBe(2);
    // That check got an answer, so the next one waits its minute again.
    advance(5000);
    await expect(watch.check({ retry: true })).resolves.toBeTruthy();
    expect(state.fetches).toBe(2);
  });

  it("back online after a check that got an answer, or none that was no failure, the minute holds", async () => {
    await expect(retriedAfterACheck("a")).resolves.toStrictEqual({
      isNew: false,
      fetches: 1,
    });
    await expect(retriedAfterACheck(null)).resolves.toStrictEqual({
      isNew: false,
      fetches: 1,
    });

    // The page has just loaded its build: nothing failed yet.
    const fresh = tab({ live: "b" });
    await expect(fresh.watch.check({ retry: true })).resolves.toBeFalsy();
    expect(fresh.state.fetches).toBe(0);
  });

  it("a different live build is new, tells the listeners once, and is not fetched again", async () => {
    const { watch, state } = tab({ live: "b" });
    let told = 0;
    watch.subscribe(() => {
      told += 1;
    });
    expect(watch.isNew()).toBeFalsy();
    await expect(watch.check({ force: true })).resolves.toBeTruthy();
    expect(watch.isNew()).toBeTruthy();
    await expect(watch.check({ force: true })).resolves.toBeTruthy();
    expect({ told, fetches: state.fetches }).toStrictEqual({
      told: 1,
      fetches: 1,
    });
  });

  it("checks at the same time share one request", async () => {
    const { watch, state } = tab({ live: "b", own: "a" });

    const results = await Promise.all([
      watch.check({ force: true }),
      watch.check({ force: true }),
      watch.check({ force: true }),
    ]);

    expect(results).toStrictEqual([true, true, true]);
    expect(state.fetches).toBe(1);
    expect(state.ownFetches).toBe(1);
  });

  it("a failed or unreadable answer leaves the tab where it is", async () => {
    const failed = tab({ live: new Error("offline") });
    await expect(failed.watch.check({ force: true })).resolves.toBeFalsy();
    const empty = tab({ live: null });
    await expect(empty.watch.check({ force: true })).resolves.toBeFalsy();
    expect(failed.watch.isNew() || empty.watch.isNew()).toBeFalsy();
  });

  it("a build the tab just reloaded for and did not get is not new again for a while", async () => {
    // The server still rendered build `a` after the assets moved on to `b`: another reload would loop.
    const { watch, advance } = tab({
      live: "b",
      storage: memoryStorage({ [RELOADED_FOR_KEY]: guard("b", 1000) }),
    });

    await expect(watch.check({ force: true })).resolves.toBeFalsy();
    advance(LOOP_GUARD_MS - 2000);
    await expect(watch.check({ force: true })).resolves.toBeFalsy();
    // A loop takes seconds. Later, a stale cache that served the old page has most likely expired,
    // and the tab tries again.
    advance(1000);
    await expect(watch.check({ force: true })).resolves.toBeTruthy();

    // A later deploy is new at once.
    const later = tab({
      live: "c",
      storage: memoryStorage({ [RELOADED_FOR_KEY]: guard("b") }),
    });

    await expect(later.watch.check({ force: true })).resolves.toBeTruthy();

    // A page that loads long after the reload tries again too.
    const stale = tab({
      live: "b",
      storage: memoryStorage({ [RELOADED_FOR_KEY]: guard("b", LOOP_GUARD_MS) }),
    });

    await expect(stale.watch.check({ force: true })).resolves.toBeTruthy();
  });

  it("a guard written before guards had a time holds from when the page loaded", async () => {
    // A tab open across the upgrade of this package, with the bare id it wrote before.
    const { watch, advance } = tab({
      live: "b",
      storage: memoryStorage({ [RELOADED_FOR_KEY]: "b" }),
    });

    advance(LOOP_GUARD_MS - 1);
    await expect(watch.check({ force: true })).resolves.toBeFalsy();
    advance(1);
    await expect(watch.check({ force: true })).resolves.toBeTruthy();
  });

  it("a guard from a clock set back since does not hold for longer", async () => {
    const { watch } = tab({
      live: "b",
      storage: memoryStorage({
        [RELOADED_FOR_KEY]: guard("b", -2 * LOOP_GUARD_MS),
      }),
    });

    await expect(watch.check({ force: true })).resolves.toBeTruthy();
  });

  it("the reload remembers the build it is for and happens once", async () => {
    const { watch, loads, storage } = tab({ live: "b" });
    watch.reload();
    expect(loads).toStrictEqual([]);
    await watch.check({ force: true });
    watch.reload("/inbox");
    watch.reload();
    expect(loads).toStrictEqual(["/inbox"]);
    expect(watch.isReloading()).toBeTruthy();
    expect(storage.getItem(RELOADED_FOR_KEY)).toBe(guard("b"));
  });

  it("a reload that did not happen starts again once the tab resumes", async () => {
    const { watch, loads } = tab({ live: "b" });
    const reloading: boolean[] = [];
    watch.subscribeToReload(() => reloading.push(watch.isReloading()));
    await watch.check({ force: true });
    watch.reload();
    // The user stayed at the page's unsaved-work prompt and clicks Reload again.
    watch.reload();
    expect(loads).toStrictEqual([undefined]);
    watch.resume();
    expect(watch.isReloading()).toBeFalsy();
    watch.reload();
    expect(loads).toStrictEqual([undefined, undefined]);
    // Stayed again, then moves to another page.
    watch.resume();
    watch.resume();
    let move: ((event: NavigationEvent) => void) | undefined;
    watch.follow({
      subscribe: (_type, fn) => {
        move = fn;

        return () => {};
      },
      history: {},
    });
    move?.({ fromLocation: {}, pathChanged: true });
    expect(loads).toStrictEqual([undefined, undefined, undefined]);
    expect(reloading).toStrictEqual([true, false, true, false, true]);
  });

  it("a chunk's reload that did not happen leaves the error to the screen", async () => {
    const { watch } = tab({ live: "a" });
    let told = 0;
    watch.subscribeToReload(() => {
      told += 1;
    });
    await expect(watch.recover(CHUNK)).resolves.toBeTruthy();
    expect(watch.isReloading()).toBeTruthy();
    watch.resume();
    expect(watch.isReloading()).toBeFalsy();
    expect(told).toBe(2);
  });

  it("an error screen reloads onto a newer build for a missing chunk, not for another error", async () => {
    const replaced = tab({ live: "b" });
    await expect(
      replaced.watch.recover(new Error("boom"))
    ).resolves.toBeFalsy();
    // Another error reads nothing from the server.
    const fetchedForTheOtherError = replaced.state.fetches;
    await expect(replaced.watch.recover(CHUNK)).resolves.toBeTruthy();
    expect({
      fetchedForTheOtherError,
      loads: replaced.loads,
    }).toStrictEqual({ fetchedForTheOtherError: 0, loads: [undefined] });
    // A second screen that caught it while the page goes shows nothing either.
    await expect(replaced.watch.recover(CHUNK)).resolves.toBeTruthy();
    expect(replaced.loads).toStrictEqual([undefined]);
  });

  it("a chunk of the live build that failed reloads the page once for that build", async () => {
    // The page's build is still the live one: the browser failed to fetch the chunk, and keeps that
    // failure for the document's life, so the tab reloads onto its own build.
    const first = tab({ live: "a" });
    await expect(first.watch.recover(CHUNK)).resolves.toBeTruthy();
    expect({
      loads: first.loads,
      reloading: first.watch.isReloading(),
      retriedFor: first.storage.getItem(CHUNK_RETRY_KEY),
    }).toStrictEqual({
      loads: [undefined],
      reloading: true,
      retriedFor: guard("a"),
    });
    // A second screen that caught it while the page goes reloads nothing more.
    await expect(first.watch.recover(CHUNK)).resolves.toBeTruthy();
    expect(first.loads).toStrictEqual([undefined]);
  });

  it("a chunk that failed again right after that reload is the screen's, for a while", async () => {
    const first = tab({ live: "a" });
    await first.watch.recover(CHUNK);
    // It failed again right after that reload: the chunk is broken, and the screen shows it.
    const again = tab({ live: "a", storage: first.storage });
    await expect(again.watch.recover(CHUNK)).resolves.toBeFalsy();
    expect(again.loads).toStrictEqual([]);
    // Another dropped connection, long after: a reload fixes it again.
    again.advance(LOOP_GUARD_MS);
    await expect(again.watch.recover(CHUNK)).resolves.toBeTruthy();
    expect({
      loads: again.loads,
      retriedFor: again.storage.getItem(CHUNK_RETRY_KEY),
    }).toStrictEqual({
      loads: [undefined],
      retriedFor: guard("a", -LOOP_GUARD_MS),
    });

    // A later build gets its own reload.
    const later = createDeployWatch({
      current: "b",
      fetchLive: answering({ id: "b" }),
      now: () => 0,
      storage: first.storage,
      load: () => {},
    });

    await expect(later.recover(CHUNK)).resolves.toBeTruthy();
  });

  it("offline, or with no storage to guard the loop, the chunk is the screen's", async () => {
    // Offline, a reload would leave the app for the browser's error page; without storage it
    // could loop. Both are the screen's.
    const offline = tab({ live: new Error("offline") });
    await expect(offline.watch.recover(CHUNK)).resolves.toBeFalsy();

    const unstored = createDeployWatch({
      current: "a",
      fetchLive: answering({ id: "a" }),
      now: () => 0,
      storage: null,
      load: () => {},
    });

    await expect(unstored.recover(CHUNK)).resolves.toBeFalsy();
    expect(unstored.isReloading()).toBeFalsy();
  });

  it("with no storage to guard the loop, an error screen does not reload onto a newer build; a move to another page still does", async () => {
    // A host that serves the old page after the assets moved on brings the error back with every
    // reload, and nothing in the tab would remember the last one. The screen shows instead.
    const screenShows = {
      forTheError: { recovers: false, reloading: false, loads: [] },
      loadsAtTheMove: [undefined],
    };

    await expect(replacedWithStorage(null)).resolves.toStrictEqual(screenShows);
    // Storage the browser hands over but refuses to write to (a full quota, blocked site data).
    await expect(
      replacedWithStorage({
        getItem: () => null,
        setItem: () => {
          throw new DOMException(
            "The quota has been exceeded.",
            "QuotaExceededError"
          );
        },
      })
    ).resolves.toStrictEqual(screenShows);
  });

  it("a deploy that leaves the page's browser code as it was is not new, once the tab knows it", async () => {
    const { watch, state, advance } = tab({ live: { id: "a", client: "c1" } });
    watch.learnOwnBuild();
    await expect(watch.check({ force: true })).resolves.toBeFalsy();
    // A commit that changed only the server.
    state.live = { id: "b", client: "c1" };
    advance(CHECK_SPACING_MS);
    await expect(watch.check()).resolves.toBeFalsy();
    expect(watch.isNew()).toBeFalsy();
    // One that changed the browser code.
    state.live = { id: "c", client: "c2" };
    advance(CHECK_SPACING_MS);
    await expect(watch.check()).resolves.toBeTruthy();
    // A tab that never read its own build's file cannot tell, and takes it as new.
    const unaware = tab({ live: { id: "b", client: "c1" } });
    await expect(unaware.watch.check({ force: true })).resolves.toBeTruthy();
  });

  it("the page's own build is read once, unless a check already read the file", async () => {
    const { watch, state } = tab({ live: { id: "a", client: "c1" } });
    watch.learnOwnBuild();
    watch.learnOwnBuild();
    await watch.check({ force: true });
    expect(state.fetches).toBe(1);
    const read = tab({ live: { id: "a", client: "c1" } });
    await read.watch.check({ force: true });
    read.watch.learnOwnBuild();
    expect(read.state.fetches).toBe(1);
  });

  it("a tab that missed its own build's file reads its build's copy after a deploy", async () => {
    const own = { id: "a", client: "c1", modules: { inbox: "i1", kb: "k1" } };
    // A deploy that changed only the server came before the tab's first read of `/build.json`.
    const { watch, state, advance } = tab({ live: { ...own, id: "b" }, own });
    let told = 0;
    watch.subscribe(() => {
      told += 1;
    });
    await expect(watch.check({ force: true })).resolves.toBeFalsy();
    // The tab learned something: `isModuleChanged` can now tell.
    expect({ ownFetches: state.ownFetches, told }).toStrictEqual({
      ownFetches: 1,
      told: 1,
    });
    // A later deploy that changed one module.
    state.live = { id: "c", client: "c2", modules: { inbox: "i1", kb: "k2" } };
    advance(CHECK_SPACING_MS);
    await expect(watch.check()).resolves.toBeTruthy();
    expect({
      inbox: watch.changes("inbox"),
      kb: watch.changes("kb"),
      ownFetches: state.ownFetches,
    }).toStrictEqual({ inbox: false, kb: true, ownFetches: 1 });
  });

  it("a tab reads its build's copy only when the live file names another build", async () => {
    // The live file still named the page's build.
    const early = tab({
      live: { id: "a", client: "c1" },
      own: { id: "a", client: "c1" },
    });

    await early.watch.check({ force: true });
    early.state.live = { id: "b", client: "c1" };
    early.advance(CHECK_SPACING_MS);
    await expect(early.watch.check()).resolves.toBeFalsy();
    // An answer that is not a build file says nothing about a deploy.
    const unanswered = tab({ live: null, own: { id: "a", client: "c1" } });
    await unanswered.watch.check({ force: true });
    expect(early.state.ownFetches + unanswered.state.ownFetches).toBe(0);
  });

  it("a tab whose build's copy is gone takes another build as new, and asks once", async () => {
    // Gone (a host that keeps no replaced assets: a 404), or another build's file.
    const asked = { isNew: true, changed: true, fetches: 2, ownFetches: 1 };
    await expect(afterADeploy(null)).resolves.toStrictEqual(asked);
    await expect(
      afterADeploy({ id: "b", client: "c1" })
    ).resolves.toStrictEqual(asked);
  });

  it("a tab asks again for its build's copy after a request that failed", async () => {
    // A deploy that changed only the server came before the tab's first read of `/build.json`,
    // and the first request for the build's copy timed out.
    const { watch, state, advance } = tab({
      live: { id: "b", client: "c1", modules: { inbox: "i1" } },
      own: new Error("timeout"),
    });

    let told = 0;
    watch.subscribe(() => {
      told += 1;
    });
    await expect(watch.check({ force: true })).resolves.toBeTruthy();
    // A later check gets the copy: the live build has the page's code after all.
    state.own = { id: "a", client: "c1", modules: { inbox: "i1" } };
    advance(CHECK_SPACING_MS);
    await expect(watch.check()).resolves.toBeFalsy();
    expect({
      isNew: watch.isNew(),
      inbox: watch.changes("inbox"),
      ownFetches: state.ownFetches,
      told,
    }).toStrictEqual({ isNew: false, inbox: false, ownFetches: 2, told: 2 });
    // It has its own build's file now, and asks no more.
    advance(CHECK_SPACING_MS);
    await watch.check();
    expect(state.ownFetches).toBe(2);
  });

  it("a tab asks for its build's copy three times at most, once a check", async () => {
    const { watch, state, advance } = tab({
      live: { id: "b", client: "c1" },
      own: new Error("offline"),
    });

    await watch.check({ force: true });
    // A check within the minute asks for nothing.
    await watch.check();
    expect(state.ownFetches).toBe(1);

    for (let checks = 0; checks < 4; checks += 1) {
      advance(CHECK_SPACING_MS);
      // oxlint-disable-next-line eslint/no-await-in-loop -- each check comes a minute after the one before has settled
      await expect(watch.check()).resolves.toBeTruthy();
    }

    expect({
      fetches: state.fetches,
      ownFetches: state.ownFetches,
    }).toStrictEqual({ fetches: 5, ownFetches: 3 });
  });

  it("a module changes only when the newer build's fingerprint for it differs", async () => {
    const own = { id: "a", client: "c1", modules: { inbox: "i1", kb: "k1" } };
    const { watch, state, advance } = tab({ live: own });
    let told = 0;
    watch.subscribe(() => {
      told += 1;
    });
    await watch.check({ force: true });
    expect(watch.changes("kb")).toBeFalsy();
    state.live = { id: "b", client: "c2", modules: { inbox: "i1", kb: "k2" } };
    advance(CHECK_SPACING_MS);
    await watch.check();
    // A name neither build has: no code of its own beyond the page that loads it.
    expect({
      kb: watch.changes("kb"),
      inbox: watch.changes("inbox"),
      billing: watch.changes("billing"),
    }).toStrictEqual({ kb: true, inbox: false, billing: false });
    // A later deploy can change the module the page shows, and the tab learns of it.
    state.live = { id: "c", client: "c3", modules: { inbox: "i2", kb: "k2" } };
    advance(CHECK_SPACING_MS);
    await expect(watch.check()).resolves.toBeTruthy();
    expect({
      inbox: watch.changes("inbox"),
      fetches: state.fetches,
      told,
    }).toStrictEqual({ inbox: true, fetches: 3, told: 3 });
  });

  it("a tab that cannot compare a module takes it as changed", async () => {
    const newer = { id: "b", client: "c2", modules: { inbox: "i1" } };
    // It never read its own build's file.
    const unaware = tab({ live: newer });
    await unaware.watch.check({ force: true });
    expect(unaware.watch.changes("inbox")).toBeTruthy();
    // Its own build's file names no modules.
    const older = tab({ live: { id: "a", client: "c1" } });
    older.watch.learnOwnBuild();
    await older.watch.check({ force: true });
    older.state.live = newer;
    older.advance(CHECK_SPACING_MS);
    await older.watch.check();
    expect(older.watch.changes("inbox")).toBeTruthy();
  });

  it("a dismissed notice stays hidden until a later build brings other browser code", async () => {
    const { watch, state, advance } = tab({ live: { id: "a", client: "c1" } });
    let told = 0;
    watch.subscribe(() => {
      told += 1;
    });
    // Nothing to dismiss before a newer build is live.
    watch.dismiss();
    expect(watch.isDismissed()).toBeFalsy();
    watch.learnOwnBuild();
    await watch.check({ force: true });
    state.live = { id: "b", client: "c2" };
    advance(CHECK_SPACING_MS);
    await watch.check();
    expect(told).toBe(2);
    // Every notice reads the dismissal, and hears of it.
    watch.dismiss();
    watch.dismiss();
    // The tab still moves onto the build at its next move.
    expect({
      dismissed: watch.isDismissed(),
      told,
      isNew: watch.isNew(),
    }).toStrictEqual({ dismissed: true, told: 3, isNew: true });
    // A deploy that changed only the server since the dismissal.
    state.live = { id: "c", client: "c2" };
    advance(CHECK_SPACING_MS);
    await watch.check();
    expect(watch.isDismissed()).toBeTruthy();
    // One that changed the browser code again.
    state.live = { id: "d", client: "c3" };
    advance(CHECK_SPACING_MS);
    await watch.check();
    expect(watch.isDismissed()).toBeFalsy();
  });

  it("without fingerprints to compare, any later build shows the notice again", async () => {
    const bare = tab({ live: "b" });
    await bare.watch.check({ force: true });
    bare.watch.dismiss();
    bare.state.live = "c";
    bare.advance(CHECK_SPACING_MS);
    await bare.watch.check();
    expect(bare.watch.isDismissed()).toBeFalsy();
  });

  it("a notice dismissed for a module shows again once a later build changes that module again", async () => {
    const { watch, state, advance } = tab({
      live: { id: "a", client: "c1", modules: { inbox: "i1", kb: "k1" } },
    });

    await watch.check({ force: true });
    state.live = { id: "b", client: "c2", modules: { inbox: "i2", kb: "k1" } };
    advance(CHECK_SPACING_MS);
    await watch.check();
    watch.dismiss("inbox");
    // Each module's notice, and the one for every newer build, has a dismissal of its own.
    expect({
      inbox: watch.isDismissed("inbox"),
      kb: watch.isDismissed("kb"),
      any: watch.isDismissed(),
    }).toStrictEqual({ inbox: true, kb: false, any: false });
    // A later deploy that changes another module.
    state.live = { id: "c", client: "c3", modules: { inbox: "i2", kb: "k2" } };
    advance(CHECK_SPACING_MS);
    await watch.check();
    expect({
      changed: watch.changes("inbox"),
      dismissed: watch.isDismissed("inbox"),
    }).toStrictEqual({ changed: true, dismissed: true });
    // One that changes the module again.
    state.live = { id: "d", client: "c4", modules: { inbox: "i3", kb: "k2" } };
    advance(CHECK_SPACING_MS);
    await watch.check();
    expect(watch.isDismissed("inbox")).toBeFalsy();
  });

  it("a tab that cannot compare a module takes any later build as changing it again", async () => {
    const unaware = tab({ live: "b" });
    await unaware.watch.check({ force: true });
    unaware.watch.dismiss("inbox");
    expect(unaware.watch.isDismissed("inbox")).toBeTruthy();
    unaware.state.live = "c";
    unaware.advance(CHECK_SPACING_MS);
    await unaware.watch.check();
    expect(unaware.watch.isDismissed("inbox")).toBeFalsy();
  });

  it("a chunk that failed while the live build has the page's browser code reloads once", async () => {
    const { watch, state, loads, storage } = tab({
      live: { id: "a", client: "c1" },
    });

    watch.learnOwnBuild();
    await watch.check({ force: true });
    // A deploy that changed only the server: the chunk is still on the server.
    state.live = { id: "b", client: "c1" };
    await expect(watch.recover(CHUNK)).resolves.toBeTruthy();
    expect(loads).toStrictEqual([undefined]);
    expect(storage.getItem(CHUNK_RETRY_KEY)).toBe(guard("a"));
  });

  it("the router's next move to another page loads it whole once a newer build is live", async () => {
    const { watch, loads } = tab({ live: "b" });
    let listener: ((event: NavigationEvent) => void) | undefined;
    // The router's history queues the address change; the reload must come after it is written.
    const steps: string[] = [];
    watch.follow({
      subscribe: (_type, fn) => {
        listener = fn;

        return () => {};
      },
      history: {
        flush: () => {
          steps.push(`flush after ${loads.length} loads`);
        },
      },
    });
    const move = (event: NavigationEvent) => listener?.(event);
    move({ fromLocation: {}, pathChanged: true });
    expect(loads).toStrictEqual([]);
    await watch.check({ force: true });
    // The first load, and a move within the page (its search), stay.
    move({ pathChanged: true });
    move({ fromLocation: {}, pathChanged: false });
    expect(loads).toStrictEqual([]);
    move({ fromLocation: {}, pathChanged: true });
    expect(loads).toStrictEqual([undefined]);
    expect(steps).toStrictEqual(["flush after 0 loads"]);
  });
});

describe(parseBuildFile, () => {
  it("reads the build from /build.json and nothing else", () => {
    expect(parseBuildFile({ id: "abc123" })).toStrictEqual({ id: "abc123" });
    expect(
      parseBuildFile({
        id: "abc123",
        client: "c1",
        modules: { inbox: "m1", kb: 2 },
      })
    ).toStrictEqual({
      id: "abc123",
      client: "c1",
      modules: { inbox: "m1" },
    });
    expect(
      parseBuildFile({ id: "abc123", client: 1, modules: ["m1"] })
    ).toStrictEqual({
      id: "abc123",
    });
    expect([
      parseBuildFile({ id: "" }),
      parseBuildFile({ id: 1 }),
      parseBuildFile("abc123"),
      parseBuildFile(null),
    ]).toStrictEqual([null, null, null, null]);
  });
});

describe(isChunkLoadError, () => {
  it("knows a chunk that failed to load in each browser's words", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://x.test/assets/a.js",
      "error loading dynamically imported module: https://x.test/assets/a.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/a.css",
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBeTruthy();
    }

    expect(isChunkLoadError(new Error("x is undefined"))).toBeFalsy();
    expect(isChunkLoadError("Importing a module script failed.")).toBeFalsy();
    expect(isChunkLoadError(null)).toBeFalsy();
  });
});
