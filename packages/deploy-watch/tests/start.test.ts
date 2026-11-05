import { afterEach, expect, test, vi } from "vitest";
import type { NavigationEvent } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A stand-in for a browser tab on build `a`, whose `/build.json` names build `b`, with the package
 * loaded fresh and the watch not started yet.
 */
async function openTab() {
  const loads: (string | undefined)[] = [];
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
  });
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    querySelector: () => ({ content: "a" }),
  });
  vi.stubGlobal("window", tabWindow);
  vi.stubGlobal("document", page);
  vi.stubGlobal("fetch", async () => Response.json({ id: "b" }));
  // A fresh module: the watch starts once per page.
  vi.resetModules();
  const deployWatch = await import("../src/index.js");
  return {
    ...deployWatch,
    loads,
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
