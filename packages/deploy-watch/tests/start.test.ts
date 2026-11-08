import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NavigationEvent } from "../src/index.js";

/** The build files the stand-in tab answers with, and the build its page runs. */
interface TabOptions {
  /** The build the page runs, as its `<meta>` names it. */
  id?: string;
  /** What `/build.json` answers. */
  live?: object;
  /** What the page's build's own copy answers; null where the host no longer serves it. */
  own?: object | null;
}

/** The fields the test sets on an event, beyond the ones `Event` itself has. */
interface EventFields {
  repeat?: boolean;
  persisted?: boolean;
}

/**
 * A stand-in for a browser tab on build `id`, whose `/build.json` answers `live` and whose build's
 * own copy answers `own` (a 404 without one), with the package loaded fresh and the watch not
 * started yet. While `network.offline`, every request fails.
 */
const openTab = async ({
  id = "a",
  live = { id: "b" },
  own = null,
}: TabOptions = {}) => {
  const loads: (string | undefined)[] = [];
  const fetched: string[] = [];
  const network = { offline: false };
  const later: (() => void)[] = [];
  const stored = new Map<string, string>();

  const tabWindow = Object.assign(new EventTarget(), {
    location: {
      reload: () => {
        loads.push(undefined);
      },
      assign: (href: string) => {
        loads.push(href);
      },
    },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    },
    setInterval: () => 0,
    // What the tab leaves for later: its first read of `/build.json`, where it cannot wait until
    // the browser is idle.
    setTimeout: (task: () => void) => {
      later.push(task);
    },
  });

  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    querySelector: () => ({ content: id }),
  });

  vi.stubGlobal("window", tabWindow);
  vi.stubGlobal("document", page);
  // oxlint-disable-next-line eslint/require-await -- `fetch` answers with a promise, and the watch awaits what this stand-in returns
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);

    if (network.offline) {
      throw new TypeError("Failed to fetch");
    }

    if (url === "/build.json") {
      return Response.json(live);
    }

    return own
      ? Response.json(own)
      : new Response("Not found", { status: 404 });
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
    dispatch: (type: string, fields: EventFields = {}) =>
      tabWindow.dispatchEvent(Object.assign(new Event(type), fields)),
    /** Starts the watch and waits until the tab knows `b` is live. */
    async start() {
      deployWatch.startDeployWatch();
      // A chunk that failed to load checks at once.
      tabWindow.dispatchEvent(new Event("vite:preloadError"));
      await vi.waitFor(() => expect(deployWatch.isNewBuildLive()).toBeTruthy());
    },
  };
};

/** The tab with its watch started, once it knows `b` is live. */
const startTab = async () => {
  const tab = await openTab();
  await tab.start();

  return tab;
};

/** A stand-in for TanStack Router: `move` fires its `onBeforeNavigate` listeners. */
const router = () => {
  const listeners = new Set<(event: NavigationEvent) => void>();

  return {
    subscribe: (
      _type: "onBeforeNavigate",
      listener: (event: NavigationEvent) => void
    ) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    history: {},
    listeners,
    move: (event: NavigationEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
};

/** What a tab loads when its router moves to another page, with the watch started in `order`. */
const loadsOnMove = async (order: "router first" | "watch first") => {
  const tab = await openTab();
  const routes = router();

  if (order === "watch first") {
    await tab.start();
  }

  tab.followNewBuild(routes);

  if (order === "router first") {
    await tab.start();
  }

  routes.move({ fromLocation: {}, pathChanged: true });

  return tab.loads;
};

describe("the tab's watch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the tab reads /build.json once the browser is idle, and its build's own copy after a deploy", async () => {
    const tab = await openTab({
      live: { id: "b", client: "c1" },
      own: { id: "a", client: "c1" },
    });

    tab.startDeployWatch();
    let told = 0;
    tab.subscribeToNewBuild(() => {
      told += 1;
    });
    expect(tab.fetched).toStrictEqual([]);

    for (const task of tab.later.splice(0)) {
      task();
    }

    await vi.waitFor(() => expect(told).toBe(1));
    expect(tab.fetched).toStrictEqual([
      "/build.json",
      "/assets/deploy-watch-a.json",
    ]);
    // The deploy changed only the server.
    expect(tab.isNewBuildLive()).toBeFalsy();
  });

  it("the first read waits until the browser is idle, where it can tell", async () => {
    const tab = await openTab({ live: { id: "a" } });
    const idle: (() => void)[] = [];
    Object.assign(tab.window, {
      requestIdleCallback: (task: () => void) => idle.push(task),
    });
    tab.startDeployWatch();
    expect(tab.later).toStrictEqual([]);

    for (const task of idle) {
      task();
    }

    await vi.waitFor(() => expect(tab.fetched).toStrictEqual(["/build.json"]));
  });

  it("back online right after a read that failed, the tab reads /build.json again", async () => {
    const tab = await openTab();
    tab.network.offline = true;
    tab.startDeployWatch();

    for (const task of tab.later.splice(0)) {
      task();
    }

    expect(tab.fetched).toStrictEqual(["/build.json"]);
    // The failed read settles.
    await sleep(0);
    // Focus within the minute waits for it, as before.
    tab.dispatch("focus");
    expect(tab.fetched).toStrictEqual(["/build.json"]);
    tab.network.offline = false;
    tab.dispatch("online");
    tab.dispatch("focus");
    await vi.waitFor(() => expect(tab.isNewBuildLive()).toBeTruthy());
    expect(tab.fetched).toStrictEqual([
      "/build.json",
      "/build.json",
      "/assets/deploy-watch-a.json",
    ]);
  });

  it("a build whose id is not a plain file name has no copy to read", async () => {
    const tab = await openTab({ id: "feature/x" });
    await tab.start();
    expect(tab.fetched).toStrictEqual(["/build.json"]);
  });

  it("a tab that stayed at the unsaved-work prompt reloads again after the next press", async () => {
    const tab = await startTab();
    tab.reloadOntoNewBuild();
    tab.reloadOntoNewBuild();
    expect({
      loads: tab.loads,
      reloading: tab.isReloadingOntoNewBuild(),
    }).toStrictEqual({ loads: [undefined], reloading: true });
    // A held key repeats the press that started the reload.
    tab.dispatch("keydown", { repeat: true });
    expect(tab.isReloadingOntoNewBuild()).toBeTruthy();
    tab.dispatch("pointerdown");
    expect(tab.isReloadingOntoNewBuild()).toBeFalsy();
    tab.reloadOntoNewBuild();
    expect(tab.loads).toStrictEqual([undefined, undefined]);
    tab.dispatch("keydown");
    expect(tab.isReloadingOntoNewBuild()).toBeFalsy();
  });

  it("a dismissal is the tab's, so a notice that mounts again stays hidden", async () => {
    const tab = await startTab();
    let told = 0;
    tab.subscribeToNewBuild(() => {
      told += 1;
    });
    expect(tab.isNewBuildNoticeDismissed()).toBeFalsy();
    tab.dismissNewBuildNotice();
    expect({
      told,
      dismissed: tab.isNewBuildNoticeDismissed(),
    }).toStrictEqual({ told: 1, dismissed: true });
    // A notice for a module has its own; this tab cannot compare modules, so it takes each as changed.
    expect({
      changed: tab.isModuleChanged("inbox"),
      dismissed: tab.isNewBuildNoticeDismissed("inbox"),
    }).toStrictEqual({ changed: true, dismissed: false });
    tab.dismissNewBuildNotice("inbox");
    // Dismissed, the tab still moves onto the new build.
    expect({
      dismissed: tab.isNewBuildNoticeDismissed("inbox"),
      live: tab.isNewBuildLive(),
    }).toStrictEqual({ dismissed: true, live: true });
  });

  it("a page the back/forward cache brings back can reload again", async () => {
    const tab = await startTab();
    let told = 0;
    tab.subscribeToReload(() => {
      told += 1;
    });
    tab.reloadOntoNewBuild("/inbox");
    // A first load is no restore.
    tab.dispatch("pageshow", { persisted: false });
    expect(tab.isReloadingOntoNewBuild()).toBeTruthy();
    tab.dispatch("pageshow", { persisted: true });
    expect(tab.isReloadingOntoNewBuild()).toBeFalsy();
    tab.reloadOntoNewBuild("/inbox");
    expect(tab.loads).toStrictEqual(["/inbox", "/inbox"]);
    expect(told).toBe(3);
  });

  it("the router follows the new build whether it is followed before or after the watch starts", async () => {
    await expect(loadsOnMove("router first")).resolves.toStrictEqual([
      undefined,
    ]);
    await expect(loadsOnMove("watch first")).resolves.toStrictEqual([
      undefined,
    ]);
  });

  it("a router followed where no watch ever starts stays as it is", async () => {
    const tab = await openTab();
    const routes = router();
    const stop = tab.followNewBuild(routes);
    routes.move({ fromLocation: {}, pathChanged: true });
    expect(tab.loads).toStrictEqual([]);
    stop();
    expect(routes.listeners.size).toBe(0);
  });

  it("on the server, following a router subscribes nothing", async () => {
    vi.resetModules();
    const { followNewBuild } = await import("../src/index.js");
    const routes = router();
    const stop = followNewBuild(routes);
    expect(routes.listeners.size).toBe(0);
    stop();
  });
});
