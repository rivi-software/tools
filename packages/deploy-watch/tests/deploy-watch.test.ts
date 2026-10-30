import { expect, test } from "vitest";
import {
  CHECK_SPACING_MS,
  CHUNK_RETRY_KEY,
  createDeployWatch,
  isChunkLoadError,
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

/** A tab on build `a`, whose `/build.json` answers `live` and whose clock the test moves. */
function tab({ live = "a" as string | null | Error, storage = memoryStorage() } = {}) {
  let time = 1_000_000;
  const loads: (string | undefined)[] = [];
  const state = { live, fetches: 0 };
  const watch = createDeployWatch({
    current: "a",
    fetchLive: async () => {
      state.fetches++;
      if (state.live instanceof Error) throw state.live;
      return state.live;
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
  const { watch, state } = tab({ live: "b" });
  const results = await Promise.all([
    watch.check({ force: true }),
    watch.check({ force: true }),
    watch.check({ force: true }),
  ]);
  expect(results).toEqual([true, true, true]);
  expect(state.fetches).toBe(1);
});

test("a failed or unreadable answer leaves the tab where it is", async () => {
  const failed = tab({ live: new Error("offline") });
  expect(await failed.watch.check({ force: true })).toBe(false);
  const empty = tab({ live: null });
  expect(await empty.watch.check({ force: true })).toBe(false);
  expect(failed.watch.isNew() || empty.watch.isNew()).toBe(false);
});

test("a build the tab already reloaded for and did not get is not new again", async () => {
  // The server still rendered build `a` after the assets moved on to `b`: another reload would loop.
  const { watch } = tab({ live: "b", storage: memoryStorage({ [RELOADED_FOR_KEY]: "b" }) });
  expect(await watch.check({ force: true })).toBe(false);
  // A later deploy is new again.
  const later = tab({ live: "c", storage: memoryStorage({ [RELOADED_FOR_KEY]: "b" }) });
  expect(await later.watch.check({ force: true })).toBe(true);
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
  expect(storage.getItem(RELOADED_FOR_KEY)).toBe("b");
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

test("a chunk of the live build that failed reloads the page once for that build", async () => {
  const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
  // The page's build is still the live one: the browser failed to fetch the chunk, and keeps that
  // failure for the document's life, so the tab reloads onto its own build.
  const first = tab({ live: "a" });
  expect(await first.watch.recover(chunk)).toBe(true);
  expect(first.loads).toEqual([undefined]);
  expect(first.watch.isReloading()).toBe(true);
  expect(first.storage.getItem(CHUNK_RETRY_KEY)).toBe("a");
  expect(await first.watch.recover(chunk)).toBe(true);
  expect(first.loads).toEqual([undefined]);
  // It failed again after that reload: the chunk is broken, and the screen shows it.
  const again = tab({ live: "a", storage: first.storage });
  expect(await again.watch.recover(chunk)).toBe(false);
  expect(again.loads).toEqual([]);
  // A later build gets its own reload.
  const later = createDeployWatch({
    current: "b",
    fetchLive: async () => "b",
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
    fetchLive: async () => "a",
    now: () => 0,
    storage: null,
    load: () => {},
  });
  expect(await unstored.recover(chunk)).toBe(false);
  expect(unstored.isReloading()).toBe(false);
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

test("reads the id from /build.json and nothing else", () => {
  expect(parseBuildFile({ id: "abc123" })).toBe("abc123");
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
