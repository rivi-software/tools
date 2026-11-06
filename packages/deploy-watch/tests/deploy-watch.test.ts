import { expect, test } from "vitest";
import {
  type BuildFile,
  CHECK_SPACING_MS,
  CHUNK_RETRY_KEY,
  createDeployWatch,
  isChunkLoadError,
  LOOP_GUARD_MS,
  parseBuildFile,
  RELOADED_FOR_KEY,
  type NavigationEvent,
} from "../src/index.js";

function memoryStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

type Answer = string | BuildFile | null | Error;

// When each test's tab loads its page.
const LOADED_AT = 1_000_000;

/** A loop guard for `id`, as the tab writes it `ago` milliseconds before its page loads. */
function guard(id: string, ago = 0) {
  return JSON.stringify({ id, at: LOADED_AT - ago });
}

/**
 * A tab on build `a`, whose `/build.json` answers `live` (a bare id is a file with only the id),
 * whose build's own copy answers `own` (left out, the tab has none to read), and whose clock the
 * test moves.
 */
function tab({
  live = "a" as Answer,
  own = undefined as Answer | undefined,
  storage = memoryStorage(),
} = {}) {
  let time = LOADED_AT;
  const loads: (string | undefined)[] = [];
  const state = { live, fetches: 0, ownFetches: 0 };
  const answer = async (value: Answer) => {
    if (value instanceof Error) throw value;
    return typeof value === "string" ? { id: value } : value;
  };
  const watch = createDeployWatch({
    current: "a",
    fetchLive: async () => {
      state.fetches++;
      return answer(state.live);
    },
    fetchOwn:
      own === undefined
        ? undefined
        : async () => {
            state.ownFetches++;
            return answer(own);
          },
    now: () => time,
    storage,
    load: (href) => void loads.push(href),
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
}

test("a tab's own activity checks at most once a minute; a failed chunk checks at once", async () => {
  const { watch, state, advance } = tab();
  // The page has just loaded its build.
  expect(await watch.check()).toBe(false);
  expect(state.fetches).toBe(0);
  advance(CHECK_SPACING_MS);
  expect(await watch.check()).toBe(false);
  expect(state.fetches).toBe(1);
  advance(5_000);
  expect(await watch.check()).toBe(false);
  expect(state.fetches).toBe(1);
  expect(await watch.check({ force: true })).toBe(false);
  expect(state.fetches).toBe(2);
});

test("back online, a tab checks at once if its last check got no answer", async () => {
  const { watch, state, advance } = tab({ live: new Error("offline") });
  advance(CHECK_SPACING_MS);
  expect(await watch.check()).toBe(false);
  expect(state.fetches).toBe(1);
  // Back online seconds later, with a deploy live meanwhile; a burst of events shares one request.
  state.live = "b";
  advance(5_000);
  expect(await Promise.all([watch.check({ retry: true }), watch.check({ retry: true })])).toEqual([
    true,
    true,
  ]);
  expect(state.fetches).toBe(2);
  // That check got an answer, so the next one waits its minute again.
  advance(5_000);
  expect(await watch.check({ retry: true })).toBe(true);
  expect(state.fetches).toBe(2);
});

test("back online after a check that got an answer, or none that was no failure, the minute holds", async () => {
  for (const live of ["a", null] as const) {
    const { watch, state, advance } = tab({ live });
    advance(CHECK_SPACING_MS);
    await watch.check();
    advance(5_000);
    expect(await watch.check({ retry: true })).toBe(false);
    expect({ live, fetches: state.fetches }).toEqual({ live, fetches: 1 });
  }
  // The page has just loaded its build: nothing failed yet.
  const fresh = tab({ live: "b" });
  expect(await fresh.watch.check({ retry: true })).toBe(false);
  expect(fresh.state.fetches).toBe(0);
});

test("a different live build is new, tells the listeners once, and is not fetched again", async () => {
  const { watch, state } = tab({ live: "b" });
  let told = 0;
  watch.subscribe(() => told++);
  expect(watch.isNew()).toBe(false);
  expect(await watch.check({ force: true })).toBe(true);
  expect(watch.isNew()).toBe(true);
  expect(await watch.check({ force: true })).toBe(true);
  expect(told).toBe(1);
  expect(state.fetches).toBe(1);
});

test("checks at the same time share one request", async () => {
  const { watch, state } = tab({ live: "b", own: "a" });
  const results = await Promise.all([
    watch.check({ force: true }),
    watch.check({ force: true }),
    watch.check({ force: true }),
  ]);
  expect(results).toEqual([true, true, true]);
  expect(state.fetches).toBe(1);
  expect(state.ownFetches).toBe(1);
});

test("a failed or unreadable answer leaves the tab where it is", async () => {
  const failed = tab({ live: new Error("offline") });
  expect(await failed.watch.check({ force: true })).toBe(false);
  const empty = tab({ live: null });
  expect(await empty.watch.check({ force: true })).toBe(false);
  expect(failed.watch.isNew() || empty.watch.isNew()).toBe(false);
});

test("a build the tab just reloaded for and did not get is not new again for a while", async () => {
  // The server still rendered build `a` after the assets moved on to `b`: another reload would loop.
  const { watch, advance } = tab({
    live: "b",
    storage: memoryStorage({ [RELOADED_FOR_KEY]: guard("b", 1_000) }),
  });
  expect(await watch.check({ force: true })).toBe(false);
  advance(LOOP_GUARD_MS - 2_000);
  expect(await watch.check({ force: true })).toBe(false);
  // A loop takes seconds. Later, a stale cache that served the old page has most likely expired,
  // and the tab tries again.
  advance(1_000);
  expect(await watch.check({ force: true })).toBe(true);
  // A later deploy is new at once.
  const later = tab({ live: "c", storage: memoryStorage({ [RELOADED_FOR_KEY]: guard("b") }) });
  expect(await later.watch.check({ force: true })).toBe(true);
  // A page that loads long after the reload tries again too.
  const stale = tab({
    live: "b",
    storage: memoryStorage({ [RELOADED_FOR_KEY]: guard("b", LOOP_GUARD_MS) }),
  });
  expect(await stale.watch.check({ force: true })).toBe(true);
});

test("a guard written before guards had a time holds from when the page loaded", async () => {
  // A tab open across the upgrade of this package, with the bare id it wrote before.
  const { watch, advance } = tab({
    live: "b",
    storage: memoryStorage({ [RELOADED_FOR_KEY]: "b" }),
  });
  advance(LOOP_GUARD_MS - 1);
  expect(await watch.check({ force: true })).toBe(false);
  advance(1);
  expect(await watch.check({ force: true })).toBe(true);
});

test("a guard from a clock set back since does not hold for longer", async () => {
  const { watch } = tab({
    live: "b",
    storage: memoryStorage({ [RELOADED_FOR_KEY]: guard("b", -2 * LOOP_GUARD_MS) }),
  });
  expect(await watch.check({ force: true })).toBe(true);
});

test("the reload remembers the build it is for and happens once", async () => {
  const { watch, loads, storage } = tab({ live: "b" });
  watch.reload();
  expect(loads).toEqual([]);
  await watch.check({ force: true });
  watch.reload("/inbox");
  watch.reload();
  expect(loads).toEqual(["/inbox"]);
  expect(watch.isReloading()).toBe(true);
  expect(storage.getItem(RELOADED_FOR_KEY)).toBe(guard("b"));
});

test("a reload that did not happen starts again once the tab resumes", async () => {
  const { watch, loads } = tab({ live: "b" });
  const reloading: boolean[] = [];
  watch.subscribeToReload(() => reloading.push(watch.isReloading()));
  await watch.check({ force: true });
  watch.reload();
  // The user stayed at the page's unsaved-work prompt and clicks Reload again.
  watch.reload();
  expect(loads).toEqual([undefined]);
  watch.resume();
  expect(watch.isReloading()).toBe(false);
  watch.reload();
  expect(loads).toEqual([undefined, undefined]);
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
  expect(loads).toEqual([undefined, undefined, undefined]);
  expect(reloading).toEqual([true, false, true, false, true]);
});

test("a chunk's reload that did not happen leaves the error to the screen", async () => {
  const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
  const { watch } = tab({ live: "a" });
  let told = 0;
  watch.subscribeToReload(() => told++);
  expect(await watch.recover(chunk)).toBe(true);
  expect(watch.isReloading()).toBe(true);
  watch.resume();
  expect(watch.isReloading()).toBe(false);
  expect(told).toBe(2);
});

test("an error screen reloads onto a newer build for a missing chunk, not for another error", async () => {
  const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
  const replaced = tab({ live: "b" });
  expect(await replaced.watch.recover(new Error("boom"))).toBe(false);
  expect(replaced.state.fetches).toBe(0);
  expect(await replaced.watch.recover(chunk)).toBe(true);
  expect(replaced.loads).toEqual([undefined]);
  // A second screen that caught it while the page goes shows nothing either.
  expect(await replaced.watch.recover(chunk)).toBe(true);
  expect(replaced.loads).toEqual([undefined]);
});

test("a chunk of the live build that failed reloads the page once for that build for a while", async () => {
  const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
  // The page's build is still the live one: the browser failed to fetch the chunk, and keeps that
  // failure for the document's life, so the tab reloads onto its own build.
  const first = tab({ live: "a" });
  expect(await first.watch.recover(chunk)).toBe(true);
  expect(first.loads).toEqual([undefined]);
  expect(first.watch.isReloading()).toBe(true);
  expect(first.storage.getItem(CHUNK_RETRY_KEY)).toBe(guard("a"));
  expect(await first.watch.recover(chunk)).toBe(true);
  expect(first.loads).toEqual([undefined]);
  // It failed again right after that reload: the chunk is broken, and the screen shows it.
  const again = tab({ live: "a", storage: first.storage });
  expect(await again.watch.recover(chunk)).toBe(false);
  expect(again.loads).toEqual([]);
  // Another dropped connection, long after: a reload fixes it again.
  again.advance(LOOP_GUARD_MS);
  expect(await again.watch.recover(chunk)).toBe(true);
  expect(again.loads).toEqual([undefined]);
  expect(again.storage.getItem(CHUNK_RETRY_KEY)).toBe(guard("a", -LOOP_GUARD_MS));
  // A later build gets its own reload.
  const later = createDeployWatch({
    current: "b",
    fetchLive: async () => ({ id: "b" }),
    now: () => 0,
    storage: first.storage,
    load: () => {},
  });
  expect(await later.recover(chunk)).toBe(true);
  // Offline, a reload would leave the app for the browser's error page; without storage it
  // could loop. Both are the screen's.
  const offline = tab({ live: new Error("offline") });
  expect(await offline.watch.recover(chunk)).toBe(false);
  const unstored = createDeployWatch({
    current: "a",
    fetchLive: async () => ({ id: "a" }),
    now: () => 0,
    storage: null,
    load: () => {},
  });
  expect(await unstored.recover(chunk)).toBe(false);
  expect(unstored.isReloading()).toBe(false);
});

test("a deploy that leaves the page's browser code as it was is not new, once the tab knows it", async () => {
  const { watch, state, advance } = tab({ live: { id: "a", client: "c1" } });
  watch.learnOwnBuild();
  expect(await watch.check({ force: true })).toBe(false);
  // A commit that changed only the server.
  state.live = { id: "b", client: "c1" };
  advance(CHECK_SPACING_MS);
  expect(await watch.check()).toBe(false);
  expect(watch.isNew()).toBe(false);
  // One that changed the browser code.
  state.live = { id: "c", client: "c2" };
  advance(CHECK_SPACING_MS);
  expect(await watch.check()).toBe(true);
  // A tab that never read its own build's file cannot tell, and takes it as new.
  const unaware = tab({ live: { id: "b", client: "c1" } });
  expect(await unaware.watch.check({ force: true })).toBe(true);
});

test("the page's own build is read once, unless a check already read the file", async () => {
  const { watch, state } = tab({ live: { id: "a", client: "c1" } });
  watch.learnOwnBuild();
  watch.learnOwnBuild();
  await watch.check({ force: true });
  expect(state.fetches).toBe(1);
  const checked = tab({ live: { id: "a", client: "c1" } });
  await checked.watch.check({ force: true });
  checked.watch.learnOwnBuild();
  expect(checked.state.fetches).toBe(1);
});

test("a tab that missed its own build's file reads its build's copy after a deploy", async () => {
  const own = { id: "a", client: "c1", modules: { inbox: "i1", kb: "k1" } };
  // A deploy that changed only the server came before the tab's first read of `/build.json`.
  const { watch, state, advance } = tab({ live: { ...own, id: "b" }, own });
  let told = 0;
  watch.subscribe(() => told++);
  expect(await watch.check({ force: true })).toBe(false);
  expect(state.ownFetches).toBe(1);
  // The tab learned something: `isModuleChanged` can now tell.
  expect(told).toBe(1);
  // A later deploy that changed one module.
  state.live = { id: "c", client: "c2", modules: { inbox: "i1", kb: "k2" } };
  advance(CHECK_SPACING_MS);
  expect(await watch.check()).toBe(true);
  expect(watch.changes("inbox")).toBe(false);
  expect(watch.changes("kb")).toBe(true);
  expect(state.ownFetches).toBe(1);
});

test("a tab reads its build's copy only when the live file names another build", async () => {
  // The live file still named the page's build.
  const early = tab({ live: { id: "a", client: "c1" }, own: { id: "a", client: "c1" } });
  await early.watch.check({ force: true });
  early.state.live = { id: "b", client: "c1" };
  early.advance(CHECK_SPACING_MS);
  expect(await early.watch.check()).toBe(false);
  // An answer that is not a build file says nothing about a deploy.
  const unanswered = tab({ live: null, own: { id: "a", client: "c1" } });
  await unanswered.watch.check({ force: true });
  expect(early.state.ownFetches + unanswered.state.ownFetches).toBe(0);
});

test("a tab whose build's copy is gone takes another build as new, and asks once", async () => {
  for (const own of [null, new Error("offline"), { id: "b", client: "c1" }]) {
    // Gone (a host that keeps no replaced assets), unanswered, or another build's file.
    const { watch, state, advance } = tab({ live: { id: "b", client: "c1" }, own });
    expect(await watch.check({ force: true })).toBe(true);
    expect(watch.changes("inbox")).toBe(true);
    state.live = { id: "c", client: "c1" };
    advance(CHECK_SPACING_MS);
    await watch.check();
    expect(state).toMatchObject({ fetches: 2, ownFetches: 1 });
  }
});

test("a module changes only when the newer build's fingerprint for it differs", async () => {
  const own = { id: "a", client: "c1", modules: { inbox: "i1", kb: "k1" } };
  const { watch, state, advance } = tab({ live: own });
  let told = 0;
  watch.subscribe(() => told++);
  await watch.check({ force: true });
  expect(watch.changes("kb")).toBe(false);
  state.live = { id: "b", client: "c2", modules: { inbox: "i1", kb: "k2" } };
  advance(CHECK_SPACING_MS);
  await watch.check();
  expect(watch.changes("kb")).toBe(true);
  expect(watch.changes("inbox")).toBe(false);
  // A name neither build has: no code of its own beyond the page that loads it.
  expect(watch.changes("billing")).toBe(false);
  // A later deploy can change the module the page shows, and the tab learns of it.
  state.live = { id: "c", client: "c3", modules: { inbox: "i2", kb: "k2" } };
  advance(CHECK_SPACING_MS);
  expect(await watch.check()).toBe(true);
  expect(watch.changes("inbox")).toBe(true);
  expect(state.fetches).toBe(3);
  expect(told).toBe(3);
});

test("a tab that cannot compare a module takes it as changed", async () => {
  const newer = { id: "b", client: "c2", modules: { inbox: "i1" } };
  // It never read its own build's file.
  const unaware = tab({ live: newer });
  await unaware.watch.check({ force: true });
  expect(unaware.watch.changes("inbox")).toBe(true);
  // Its own build's file names no modules.
  const older = tab({ live: { id: "a", client: "c1" } });
  older.watch.learnOwnBuild();
  await older.watch.check({ force: true });
  older.state.live = newer;
  older.advance(CHECK_SPACING_MS);
  await older.watch.check();
  expect(older.watch.changes("inbox")).toBe(true);
});

test("a dismissed notice stays hidden until a later build brings other browser code", async () => {
  const { watch, state, advance } = tab({ live: { id: "a", client: "c1" } });
  let told = 0;
  watch.subscribe(() => told++);
  // Nothing to dismiss before a newer build is live.
  watch.dismiss();
  expect(watch.isDismissed()).toBe(false);
  watch.learnOwnBuild();
  await watch.check({ force: true });
  state.live = { id: "b", client: "c2" };
  advance(CHECK_SPACING_MS);
  await watch.check();
  expect(told).toBe(2);
  // Every notice reads the dismissal, and hears of it.
  watch.dismiss();
  watch.dismiss();
  expect(watch.isDismissed()).toBe(true);
  expect(told).toBe(3);
  // The tab still moves onto the build at its next move.
  expect(watch.isNew()).toBe(true);
  // A deploy that changed only the server since the dismissal.
  state.live = { id: "c", client: "c2" };
  advance(CHECK_SPACING_MS);
  await watch.check();
  expect(watch.isDismissed()).toBe(true);
  // One that changed the browser code again.
  state.live = { id: "d", client: "c3" };
  advance(CHECK_SPACING_MS);
  await watch.check();
  expect(watch.isDismissed()).toBe(false);
  // Without fingerprints, any later build shows it again.
  const bare = tab({ live: "b" });
  await bare.watch.check({ force: true });
  bare.watch.dismiss();
  bare.state.live = "c";
  bare.advance(CHECK_SPACING_MS);
  await bare.watch.check();
  expect(bare.watch.isDismissed()).toBe(false);
});

test("a notice dismissed for a module shows again once a later build changes that module again", async () => {
  const { watch, state, advance } = tab({
    live: { id: "a", client: "c1", modules: { inbox: "i1", kb: "k1" } },
  });
  await watch.check({ force: true });
  state.live = { id: "b", client: "c2", modules: { inbox: "i2", kb: "k1" } };
  advance(CHECK_SPACING_MS);
  await watch.check();
  watch.dismiss("inbox");
  expect(watch.isDismissed("inbox")).toBe(true);
  // Each module's notice, and the one for every newer build, has a dismissal of its own.
  expect(watch.isDismissed("kb")).toBe(false);
  expect(watch.isDismissed()).toBe(false);
  // A later deploy that changes another module.
  state.live = { id: "c", client: "c3", modules: { inbox: "i2", kb: "k2" } };
  advance(CHECK_SPACING_MS);
  await watch.check();
  expect(watch.changes("inbox")).toBe(true);
  expect(watch.isDismissed("inbox")).toBe(true);
  // One that changes the module again.
  state.live = { id: "d", client: "c4", modules: { inbox: "i3", kb: "k2" } };
  advance(CHECK_SPACING_MS);
  await watch.check();
  expect(watch.isDismissed("inbox")).toBe(false);
  // A tab that cannot compare the module takes any later build as changing it again.
  const unaware = tab({ live: "b" });
  await unaware.watch.check({ force: true });
  unaware.watch.dismiss("inbox");
  expect(unaware.watch.isDismissed("inbox")).toBe(true);
  unaware.state.live = "c";
  unaware.advance(CHECK_SPACING_MS);
  await unaware.watch.check();
  expect(unaware.watch.isDismissed("inbox")).toBe(false);
});

test("a chunk that failed while the live build has the page's browser code reloads once", async () => {
  const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
  const { watch, state, loads, storage } = tab({ live: { id: "a", client: "c1" } });
  watch.learnOwnBuild();
  await watch.check({ force: true });
  // A deploy that changed only the server: the chunk is still on the server.
  state.live = { id: "b", client: "c1" };
  expect(await watch.recover(chunk)).toBe(true);
  expect(loads).toEqual([undefined]);
  expect(storage.getItem(CHUNK_RETRY_KEY)).toBe(guard("a"));
});

test("the router's next move to another page loads it whole once a newer build is live", async () => {
  const { watch, loads } = tab({ live: "b" });
  let listener: ((event: NavigationEvent) => void) | undefined;
  // The router's history queues the address change; the reload must come after it is written.
  const steps: string[] = [];
  watch.follow({
    subscribe: (_type, fn) => {
      listener = fn;
      return () => {};
    },
    history: { flush: () => void steps.push(`flush after ${loads.length} loads`) },
  });
  const move = (event: NavigationEvent) => listener?.(event);
  move({ fromLocation: {}, pathChanged: true });
  expect(loads).toEqual([]);
  await watch.check({ force: true });
  // The first load, and a move within the page (its search), stay.
  move({ pathChanged: true });
  move({ fromLocation: {}, pathChanged: false });
  expect(loads).toEqual([]);
  move({ fromLocation: {}, pathChanged: true });
  expect(loads).toEqual([undefined]);
  expect(steps).toEqual(["flush after 0 loads"]);
});

test("reads the build from /build.json and nothing else", () => {
  expect(parseBuildFile({ id: "abc123" })).toEqual({ id: "abc123" });
  expect(parseBuildFile({ id: "abc123", client: "c1", modules: { inbox: "m1", kb: 2 } })).toEqual({
    id: "abc123",
    client: "c1",
    modules: { inbox: "m1" },
  });
  expect(parseBuildFile({ id: "abc123", client: 1, modules: ["m1"] })).toEqual({ id: "abc123" });
  expect(parseBuildFile({ id: "" })).toBeNull();
  expect(parseBuildFile({ id: 1 })).toBeNull();
  expect(parseBuildFile("abc123")).toBeNull();
  expect(parseBuildFile(null)).toBeNull();
});

test("knows a chunk that failed to load in each browser's words", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: https://x.test/assets/a.js",
    "error loading dynamically imported module: https://x.test/assets/a.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/a.css",
  ])
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  expect(isChunkLoadError(new Error("x is undefined"))).toBe(false);
  expect(isChunkLoadError("Importing a module script failed.")).toBe(false);
  expect(isChunkLoadError(null)).toBe(false);
});
