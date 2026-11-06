import { afterEach, expect, test, vi } from "vitest";
import type { NavigationEvent } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A stand-in for a browser tab on build `id`, whose `/build.json` answers `live` and whose build's
 * own copy answers `own` (a 404 without one), with the package loaded fresh and the watch not
 * started yet. While `network.offline`, every request fails.
 */
async function openTab({
  id = "a",
  live = { id: "b" } as object,
  own = null as object | null,
} = {}) {
  const loads: (string | undefined)[] = [];
  const fetched: string[] = [];
  const network = { offline: false };
  const later: (() => void)[] = [];
  const stored = new Map<string, string>();
  const tabWindow = Object.assign(new EventTarget(), {
    location: {
      reload: () => void loads.push(undefined),
      assign: (href: string) => void loads.push(href),
    },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
    setInterval: () => 0,
    // What the tab leaves for later: its first read of `/build.json`, where it cannot wait until
    // the browser is idle.
    setTimeout: (callback: () => void) => void later.push(callback),
  });
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    querySelector: () => ({ content: id }),
  });
  vi.stubGlobal("window", tabWindow);
  vi.stubGlobal("document", page);
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    if (network.offline) throw new TypeError("Failed to fetch");
    if (url === "/build.json") return Response.json(live);
    return own ? Response.json(own) : new Response("Not found", { status: 404 });
  });
  // A fresh module: the watch starts once per page.
  vi.resetModules();
  const deployWatch = await import("../src/index.js");
  return {
    ...deployWatch,
    window: tabWindow,
    loads,
    fetched,
    later,
    network,
    dispatch: (type: string, fields: Record<string, unknown> = {}) =>
      tabWindow.dispatchEvent(Object.assign(new Event(type), fields)),
    /** Starts the watch and waits until the tab knows `b` is live. */
    async start() {
      deployWatch.startDeployWatch();
      // A chunk that failed to load checks at once.
      tabWindow.dispatchEvent(new Event("vite:preloadError"));
      await vi.waitFor(() => expect(deployWatch.isNewBuildLive()).toBe(true));
    },
  };
}

/** The tab with its watch started, once it knows `b` is live. */
async function startTab() {
  const tab = await openTab();
  await tab.start();
  return tab;
}

/** A stand-in for TanStack Router: `move` fires its `onBeforeNavigate` listeners. */
function router() {
  const listeners = new Set<(event: NavigationEvent) => void>();
  return {
    subscribe: (_type: "onBeforeNavigate", listener: (event: NavigationEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    history: {},
    listeners,
    move: (event: NavigationEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

test("the tab reads /build.json once the browser is idle, and its build's own copy after a deploy", async () => {
  const tab = await openTab({ live: { id: "b", client: "c1" }, own: { id: "a", client: "c1" } });
  tab.startDeployWatch();
  let told = 0;
  tab.subscribeToNewBuild(() => told++);
  expect(tab.fetched).toEqual([]);
  for (const callback of tab.later.splice(0)) callback();
  await vi.waitFor(() => expect(told).toBe(1));
  expect(tab.fetched).toEqual(["/build.json", "/assets/deploy-watch-a.json"]);
  // The deploy changed only the server.
  expect(tab.isNewBuildLive()).toBe(false);
});

test("the first read waits until the browser is idle, where it can tell", async () => {
  const tab = await openTab({ live: { id: "a" } });
  const idle: (() => void)[] = [];
  Object.assign(tab.window, { requestIdleCallback: (callback: () => void) => idle.push(callback) });
  tab.startDeployWatch();
  expect(tab.later).toEqual([]);
  idle.forEach((callback) => callback());
  await vi.waitFor(() => expect(tab.fetched).toEqual(["/build.json"]));
});

test("back online right after a read that failed, the tab reads /build.json again", async () => {
  const tab = await openTab();
  tab.network.offline = true;
  tab.startDeployWatch();
  for (const callback of tab.later.splice(0)) callback();
  expect(tab.fetched).toEqual(["/build.json"]);
  // The failed read settles.
  await new Promise((resolve) => setTimeout(resolve));
  // Focus within the minute waits for it, as before.
  tab.dispatch("focus");
  expect(tab.fetched).toEqual(["/build.json"]);
  tab.network.offline = false;
  tab.dispatch("online");
  tab.dispatch("focus");
  await vi.waitFor(() => expect(tab.isNewBuildLive()).toBe(true));
  expect(tab.fetched).toEqual(["/build.json", "/build.json", "/assets/deploy-watch-a.json"]);
});

test("a build whose id is not a plain file name has no copy to read", async () => {
  const tab = await openTab({ id: "feature/x" });
  await tab.start();
  expect(tab.fetched).toEqual(["/build.json"]);
});

test("a tab that stayed at the unsaved-work prompt reloads again after the next press", async () => {
  const tab = await startTab();
  tab.reloadOntoNewBuild();
  tab.reloadOntoNewBuild();
  expect(tab.loads).toEqual([undefined]);
  expect(tab.isReloadingOntoNewBuild()).toBe(true);
  // A held key repeats the press that started the reload.
  tab.dispatch("keydown", { repeat: true });
  expect(tab.isReloadingOntoNewBuild()).toBe(true);
  tab.dispatch("pointerdown");
  expect(tab.isReloadingOntoNewBuild()).toBe(false);
  tab.reloadOntoNewBuild();
  expect(tab.loads).toEqual([undefined, undefined]);
  tab.dispatch("keydown");
  expect(tab.isReloadingOntoNewBuild()).toBe(false);
});

test("a dismissal is the tab's, so a notice that mounts again stays hidden", async () => {
  const tab = await startTab();
  let told = 0;
  tab.subscribeToNewBuild(() => told++);
  expect(tab.isNewBuildNoticeDismissed()).toBe(false);
  tab.dismissNewBuildNotice();
  expect(told).toBe(1);
  expect(tab.isNewBuildNoticeDismissed()).toBe(true);
  // A notice for a module has its own; this tab cannot compare modules, so it takes each as changed.
  expect(tab.isModuleChanged("inbox")).toBe(true);
  expect(tab.isNewBuildNoticeDismissed("inbox")).toBe(false);
  tab.dismissNewBuildNotice("inbox");
  expect(tab.isNewBuildNoticeDismissed("inbox")).toBe(true);
  // Dismissed, the tab still moves onto the new build.
  expect(tab.isNewBuildLive()).toBe(true);
});

test("a page the back/forward cache brings back can reload again", async () => {
  const tab = await startTab();
  let told = 0;
  tab.subscribeToReload(() => told++);
  tab.reloadOntoNewBuild("/inbox");
  // A first load is no restore.
  tab.dispatch("pageshow", { persisted: false });
  expect(tab.isReloadingOntoNewBuild()).toBe(true);
  tab.dispatch("pageshow", { persisted: true });
  expect(tab.isReloadingOntoNewBuild()).toBe(false);
  tab.reloadOntoNewBuild("/inbox");
  expect(tab.loads).toEqual(["/inbox", "/inbox"]);
  expect(told).toBe(3);
});

test("the router follows the new build whether it is followed before or after the watch starts", async () => {
  for (const order of ["router first", "watch first"]) {
    const tab = await openTab();
    const routes = router();
    if (order === "watch first") await tab.start();
    tab.followNewBuild(routes);
    if (order === "router first") await tab.start();
    routes.move({ fromLocation: {}, pathChanged: true });
    expect({ order, loads: tab.loads }).toEqual({ order, loads: [undefined] });
  }
});

test("a router followed where no watch ever starts stays as it is", async () => {
  const tab = await openTab();
  const routes = router();
  const stop = tab.followNewBuild(routes);
  routes.move({ fromLocation: {}, pathChanged: true });
  expect(tab.loads).toEqual([]);
  stop();
  expect(routes.listeners.size).toBe(0);
});

test("on the server, following a router subscribes nothing", async () => {
  vi.resetModules();
  const { followNewBuild } = await import("../src/index.js");
  const routes = router();
  const stop = followNewBuild(routes);
  expect(routes.listeners.size).toBe(0);
  stop();
});
