/**
 * A tab keeps running the build it loaded, and a deploy serves only its own hashed chunks. This
 * notices the deploy and moves the tab onto it at a moment that loses nothing:
 *
 * - The page's build id is in its `<meta name="deploy-watch-build">` (the server writes it,
 *   `BuildMeta` in `./react`); the live build's is in `/build.json` (the Vite plugin, `./vite`,
 *   writes it into the static assets, so reading it costs no server request).
 * - `startDeployWatch` reads `/build.json` when the tab comes back into view, gets focus or comes
 *   back online (at most once a minute, unless the last read got no answer and the browser is
 *   back online), every ten minutes while it is visible, and at once when a chunk fails to load.
 * - Once a newer build is live, the next move to another page loads the whole page
 *   (`followNewBuild`), after the app's unsaved-work guards have run; a notice can offer the
 *   reload (`useNewBuildNotice` in `./react`), and once dismissed waits for a later build; and an
 *   error screen that caught a missing chunk reloads onto the new build instead of showing
 *   (`recoverFromChunkError`), once the tab has stored the loop guard that stops a reload loop.
 * - `/build.json` also carries the browser code's fingerprint and each named module's. A deploy
 *   that leaves the page's browser code as it was is not new to the tab, and a notice for a
 *   module waits until a deploy changes that module (`isModuleChanged`).
 * - To compare, the tab needs its own build's file. It reads `/build.json` once the browser is
 *   idle after the page loads, while it most likely still names the page's build; once a deploy
 *   has replaced it, the tab reads the copy under its build's own name in the assets directory
 *   (`assets/deploy-watch-<id>.json`), where a host that keeps a replaced build's assets still
 *   serves it. A request for it that failed is asked again at a later check, a few times.
 *
 * A failed hover or idle preload only triggers the check: the page reloads when it needs the
 * code, never under someone reading or typing. A chunk that fails while the page's build is
 * still the live one is on the server, so the browser failed to fetch it: the error screen
 * reloads the page once for that build, and a second failure within `LOOP_GUARD_MS` is a real
 * fault and stays the screen's. In development, and in any build without an id, nothing runs.
 */

import { ownBuildFilePath } from "./own-build-file.js";

declare const __DEPLOY_WATCH_BUILD_ID__: string | undefined;
declare const __DEPLOY_WATCH_BUILD_FILE__: string | undefined;
declare const __DEPLOY_WATCH_ASSETS_DIR__: string | undefined;

/** The `<meta>` the server writes the page's build id into. */
export const BUILD_META_NAME = "deploy-watch-build";

/**
 * The live build's file, from the static assets (`BuildFile`). This is where it is with Vite's
 * default `base`; the Vite plugin tells the browser where it is under another one.
 */
export const BUILD_FILE = "/build.json";

/**
 * The fewest milliseconds between two checks a tab's own activity starts. A failed chunk checks
 * at once, and so does coming back online after a check that got no answer.
 */
export const CHECK_SPACING_MS = 60_000;

/** How often a visible tab checks on its own. */
export const CHECK_INTERVAL_MS = 10 * 60_000;

// How many times a tab asks for its own build's copy, at most once a check, while each request
// fails without saying the copy is gone.
const OWN_BUILD_ASKS = 3;

// The longest the first read of the live file waits for the browser to be idle after the watch
// starts, and how long it waits where the browser cannot say.
const IDLE_READ_MS = 2000;

/** The build this tab last reloaded for, and when, in its session storage. */
export const RELOADED_FOR_KEY = "deploy-watch:reloaded-for";

/**
 * The live build this tab last reloaded on because one of its chunks failed, and when, in its
 * session storage.
 */
export const CHUNK_RETRY_KEY = "deploy-watch:chunk-retry-for";

/**
 * How long a loop guard (`RELOADED_FOR_KEY`, `CHUNK_RETRY_KEY`) holds. A reload loop takes
 * seconds; after this, a later check can try the reload again.
 */
export const LOOP_GUARD_MS = CHECK_INTERVAL_MS;

type SessionStore = Pick<Storage, "getItem" | "setItem">;

/** A loop guard: the build a reload was for, and when the tab wrote it. */
interface Guard {
  id: string;
  at: number;
}

/** What `/build.json` says about a build; the Vite plugin writes it. */
export interface BuildFile {
  /** The build's id: the commit it was built from. */
  id: string;
  /** Its browser code's fingerprint: the same in every build whose browser code is the same. */
  client?: string;
  /** Each named module's fingerprint: the code it adds to the page that loads it. */
  modules?: Readonly<Record<string, string>>;
}

export interface DeployWatchDeps {
  /** The build this page runs. */
  current: string;
  /** The live build's file; null when the answer is not one. */
  fetchLive: () => Promise<BuildFile | null>;
  /**
   * The page's own build's file, from where it stays served after a deploy replaced the build;
   * null when it is gone. A rejection is a request that failed, and a later check asks again.
   * Without it, the tab learns its own build only from the live file.
   */
  fetchOwn?: () => Promise<BuildFile | null>;
  now: () => number;
  /** The tab's session storage; null where the browser refuses it. */
  storage: SessionStore | null;
  /** Loads `href` as a whole page, or this page again without one. */
  load: (href?: string) => void;
}

/** The navigation event `followNewBuild` reads (TanStack Router's `onBeforeNavigate`). */
export interface NavigationEvent {
  fromLocation?: unknown;
  pathChanged: boolean;
}

/** The router `followNewBuild` follows (TanStack Router's). */
export interface NavigationEvents {
  subscribe: (
    eventType: "onBeforeNavigate",
    listener: (event: NavigationEvent) => void
  ) => () => void;
  /** Its history, which queues the address change a move makes; `flush` writes it at once. */
  history: { flush?: () => void };
}

/** A loop guard as `JSON.parse` returns it, before its fields are read. */
interface RawGuard {
  id?: unknown;
  at?: unknown;
}

/** A `/build.json` body as it arrives, before its fields are read. */
interface RawBuildFile {
  id?: unknown;
  client?: unknown;
  modules?: unknown;
}

/** Whether `value` is an object: what a parsed body, or a thrown error, can be. */
const isObject = (value: unknown): value is object =>
  !!value && typeof value === "object";

/** Whether `value` is a string with something in it, as a build's id and fingerprint are. */
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Whether `value` is a map of names to values, as a build file's `modules` is. */
const isMap = (value: unknown): value is object =>
  isObject(value) && !Array.isArray(value);

const isRawGuard = (value: unknown): value is RawGuard => isObject(value);

const isRawBuildFile = (body: unknown): body is RawBuildFile => isObject(body);

/** Whether a value read back from the tab's session storage is a loop guard. */
const isGuard = (value: unknown): value is Guard =>
  isRawGuard(value) &&
  typeof value.id === "string" &&
  typeof value.at === "number";

/**
 * The guard under `key` in the tab's session storage. A bare id, as the tab wrote it before guards
 * had a time, reads as written at `loadedAt`, when the page loaded.
 */
const readGuard = (
  storage: SessionStore | null,
  key: string,
  loadedAt: number
): Guard | null => {
  let value: string | null;

  try {
    value = storage?.getItem(key) ?? null;
  } catch {
    return null;
  }

  if (!value) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (isGuard(parsed)) {
      return { id: parsed.id, at: parsed.at };
    }
  } catch {
    // Not JSON: a bare id.
  }

  return { id: value, at: loadedAt };
};

// The errors Vite's preload helper announced with `vite:preloadError`: the same object reaches the
// caller (React.lazy, the router's lazy route component) and the error boundary behind it.
const failedChunks = new WeakSet<object>();

const chunkErrorMessages = [
  // Chromium, Firefox and Safari's dynamic import failures, as TanStack Router's
  // `isModuleNotFoundError` reads them; then Vite's for a route's stylesheet.
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Unable to preload CSS",
];

/** Whether `error` is a chunk of code or style that did not load. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the value an error boundary caught, which no schema describes
export const isChunkLoadError = (error: unknown): boolean => {
  if (isObject(error) && failedChunks.has(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : "";

  return chunkErrorMessages.some((prefix) => message.startsWith(prefix));
};

export type DeployWatch = ReturnType<typeof createDeployWatch>;

/** One tab's watch, over the dependencies `startDeployWatch` gives it in the browser. */
export const createDeployWatch = ({
  current,
  fetchLive,
  fetchOwn,
  now,
  storage,
  load,
}: DeployWatchDeps) => {
  const loadedAt = now();
  // A build this tab just reloaded for and still did not get (a server, or a cache, that serves the
  // old build after the assets moved on) is not new to it: reloading for it again would loop.
  const reloadedFor = readGuard(storage, RELOADED_FOR_KEY, loadedAt);
  // The build this tab just reloaded on because one of its own chunks failed to load.
  const retriedFor = readGuard(storage, CHUNK_RETRY_KEY, loadedAt);
  // The page has just loaded the build it runs, so the first check waits like any other.
  let lastCheck = loadedAt;
  let asked = false;
  // Whether the last check's request failed, so it got no answer (offline): it saw no deploy.
  let unanswered = false;
  // The page's own build, as `/build.json` described it while it was live, or its own copy did.
  let own: BuildFile | null = null;
  // How many times the tab asked for its own build's copy, and whether an answer said it is gone.
  let ownAsks = 0;
  let ownGone = false;
  // The newer build's file once one is live, the latest such answer.
  let live: BuildFile | null = null;
  // Whether the last check read a build with the page's own browser code; false when
  // `/build.json` did not answer.
  let answeredOwnCode = false;
  let pending: Promise<boolean> | null = null;
  let reloading = false;
  // The live build each notice was dismissed for, by the module it shows (`undefined` for the
  // notice for every newer build). Every notice in the tab reads it.
  const dismissed = new Map<string | undefined, BuildFile>();
  const listeners = new Set<() => void>();
  const reloadListeners = new Set<() => void>();

  /**
   * Whether `guard` is for `build` and still holds: written less than `LOOP_GUARD_MS` ago, or
   * ahead, by a clock set back since.
   */
  const holds = (guard: Guard | null, build: string): boolean =>
    guard?.id === build && Math.abs(now() - guard.at) < LOOP_GUARD_MS;

  /**
   * Whether `build` runs the page's browser code: the page's own build, or a later one whose
   * browser code is the same (a deploy that changed only the server). Unknown until the tab has
   * read its own build's file, and then the build counts as new.
   */
  const sameCode = (build: BuildFile): boolean =>
    build.id === current || (!!own?.client && build.client === own.client);

  /**
   * Whether `later` has other code than `earlier`: `module`'s, where both files fingerprint their
   * modules, or else the browser code's. Without a fingerprint to compare, any other build does.
   */
  const differs = (
    earlier: BuildFile,
    later: BuildFile,
    module?: string
  ): boolean => {
    if (later.id === earlier.id) {
      return false;
    }

    if (module !== undefined && earlier.modules && later.modules) {
      return earlier.modules[module] !== later.modules[module];
    }

    return !earlier.client || later.client !== earlier.client;
  };

  /**
   * The page's own build's file, for a tab whose live file already names another build. An
   * answer is final: a host that keeps no replaced build's assets has none, and a file of another
   * build is not the page's. A request that failed (a timeout, the network, a server error) says
   * nothing, so a later check asks again, up to `OWN_BUILD_ASKS` times in all.
   */
  const readOwn = async (): Promise<BuildFile | null> => {
    if (!fetchOwn || ownGone || ownAsks >= OWN_BUILD_ASKS) {
      return null;
    }

    ownAsks += 1;

    try {
      const file = await fetchOwn();
      ownGone = true;

      return file?.id === current ? file : null;
    } catch {
      return null;
    }
  };

  /**
   * Whether a newer build is live. `force` skips the spacing, for a chunk that failed; `retry`
   * skips it only when the last check got no answer, for a browser back online. A check under
   * way answers every call meanwhile. Once a newer build is live, it stays new for the tab, and
   * later checks keep reading `/build.json` for a deploy after it, which may change another module.
   */
  const check = ({
    force = false,
    retry = false,
  }: { force?: boolean; retry?: boolean } = {}): Promise<boolean> => {
    // A chunk that failed on a page a newer build replaced needs no answer: the page reloads.
    if (live && force) {
      return Promise.resolve(true);
    }

    if (pending) {
      return pending;
    }

    if (
      !force &&
      !(retry && unanswered) &&
      now() - lastCheck < CHECK_SPACING_MS
    ) {
      return Promise.resolve(live !== null);
    }

    lastCheck = now();
    asked = true;
    unanswered = false;
    pending = fetchLive()
      .catch(() => {
        unanswered = true;

        return null;
      })
      .then(async (answer) => {
        let changed = false;

        // The live file names the page's own build until a deploy replaces it; after one, the
        // tab reads its build's own copy, which tells it whether the live build has other code.
        if (answer && !own) {
          own = answer.id === current ? answer : await readOwn();
          changed = own !== null;

          // A build taken as new only because the tab could not tell has the page's code after all.
          if (live && sameCode(live)) {
            live = null;
          }
        }

        pending = null;
        answeredOwnCode = answer !== null && sameCode(answer);

        if (
          answer &&
          !answeredOwnCode &&
          !holds(reloadedFor, answer.id) &&
          answer.id !== live?.id
        ) {
          live = answer;
          changed = true;
        }

        if (changed) {
          for (const listener of listeners) {
            listener();
          }
        }

        return live !== null;
      });

    return pending;
  };

  /**
   * Writes a guard for `build` under `key` in the tab's session storage; false where the browser
   * refuses it.
   */
  const remember = (key: string, build: string): boolean => {
    if (!storage) {
      return false;
    }

    try {
      storage.setItem(
        key,
        JSON.stringify({ id: build, at: now() } satisfies Guard)
      );

      return true;
    } catch {
      return false;
    }
  };

  /** Marks the tab as reloading or not, and tells the reload listeners when that changes. */
  const setReloading = (value: boolean) => {
    if (reloading === value) {
      return;
    }

    reloading = value;

    for (const listener of reloadListeners) {
      listener();
    }
  };

  /**
   * Moves the tab onto the live build, `href` as a whole page or this page again, after writing
   * the loop guard; whether the tab is reloading. Where the browser refuses storage, the reload
   * happens without the guard only when `guardOptional`. An error screen's reload does not: a host
   * that serves the old page again would bring the error back and loop it.
   */
  const startReload = ({
    href,
    guardOptional = false,
  }: {
    href?: string;
    guardOptional?: boolean;
  } = {}): boolean => {
    if (reloading) {
      return true;
    }

    if (!live || !(remember(RELOADED_FOR_KEY, live.id) || guardOptional)) {
      return false;
    }

    setReloading(true);
    load(href);

    return true;
  };

  /**
   * Moves the tab onto the live build: `href` as a whole page, or this page again. For the
   * notice, which the user starts, and a move to another page; both happen without storage too.
   */
  const reload = (href?: string) => {
    startReload({ href, guardOptional: true });
  };

  /**
   * For `router`'s `onBeforeNavigate`: once a newer build is live, a move to another page loads
   * the whole page. The event fires once the router's blockers let the move through, with the
   * address change still queued in its history: flushed, the address is the destination, and
   * reloading lands there with one history entry. A move within the page (its search or hash) and
   * the first load stay as they are.
   */
  const beforeNavigate = (router: NavigationEvents, event: NavigationEvent) => {
    if (!event.fromLocation || !event.pathChanged || !live) {
      return;
    }

    router.history.flush?.();
    reload();
  };

  return {
    check,
    reload,
    isNew: () => live !== null,
    /**
     * Whether a newer build is live and changes `module`'s code. True as well when the tab cannot
     * tell: it has not read its own build's file, or either file has no module fingerprints. A
     * module neither build names has no code of its own, and never changes.
     */
    changes(module: string): boolean {
      return live !== null && (!own || differs(own, live, module));
    },
    /**
     * Hides the notice for `module`, or the one for every newer build without it, until a later
     * build has other code: that module's, or else other browser code. Every notice hears of it.
     */
    dismiss(module?: string) {
      if (!live || dismissed.get(module) === live) {
        return;
      }

      dismissed.set(module, live);

      for (const listener of listeners) {
        listener();
      }
    },
    /** Whether the notice for `module`, or for every newer build, was dismissed for the live code. */
    isDismissed(module?: string): boolean {
      const build = dismissed.get(module);

      return !!live && !!build && !differs(build, live, module);
    },
    /**
     * Reads `/build.json` once, unless a check already has. Soon after the page loads it still
     * names the page's own build, so a later deploy can be compared with it module by module;
     * if it names another build, the tab reads its own build's copy.
     */
    learnOwnBuild() {
      if (!asked) {
        void check({ force: true });
      }
    },
    isReloading: () => reloading,
    /**
     * The page is still here after a reload started: the user stayed at its unsaved-work prompt,
     * or the back/forward cache brought it back. The tab can reload again, and errors are faults
     * again.
     */
    resume() {
      setReloading(false);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    /** Calls `listener` when `isReloading()` changes. */
    subscribeToReload(listener: () => void) {
      reloadListeners.add(listener);

      return () => {
        reloadListeners.delete(listener);
      };
    },
    /**
     * For an error screen: true when `error` is a chunk that did not load and the tab is reloading,
     * onto the new build or, once per build within `LOOP_GUARD_MS`, onto its own. Either reload
     * needs its loop guard written; without storage, the error is the screen's.
     */
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the value an error screen caught, which no schema describes
    async recover(error: unknown): Promise<boolean> {
      if (!isChunkLoadError(error)) {
        return false;
      }

      if (await check({ force: true })) {
        return startReload();
      }

      if (reloading) {
        return true;
      }

      // `/build.json` names the page's own browser code, so the chunk is on the server and the
      // browser failed to fetch it. Chromium keeps a failed module import for the life of the
      // document (whatwg/html#6768), so only a new page fetches it again. The tab reloads once for
      // its build; a second failure soon after, an unanswered check (offline) or no storage to
      // remember the first reload in is the screen's.
      if (
        !answeredOwnCode ||
        holds(retriedFor, current) ||
        !remember(CHUNK_RETRY_KEY, current)
      ) {
        return false;
      }

      setReloading(true);
      load();

      return true;
    },
    beforeNavigate,
    /** The router's next move to another page loads the whole page once a newer build is live. */
    follow(router: NavigationEvents) {
      return router.subscribe("onBeforeNavigate", (event) =>
        beforeNavigate(router, event)
      );
    },
  };
};

/** The build a `/build.json` body describes, or null for anything else. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the parser: it takes the body as `fetch` handed it over
export const parseBuildFile = (body: unknown): BuildFile | null => {
  if (!isRawBuildFile(body)) {
    return null;
  }

  const { id, client, modules } = body;

  if (!isText(id)) {
    return null;
  }

  const build: BuildFile = { id };

  if (isText(client)) {
    build.client = client;
  }

  if (isMap(modules)) {
    build.modules = Object.fromEntries(
      Object.entries(modules).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  }

  return build;
};

/**
 * The build this page runs: on the server, the id the Vite plugin gave the build; in the browser,
 * the one the server wrote into the page. Empty in development and in a build without an id.
 */
export const pageBuildId = (): string => {
  if (typeof document === "undefined") {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a build without the Vite plugin leaves the define out, so the name is not declared at all and only `typeof` may read it
    return typeof __DEPLOY_WATCH_BUILD_ID__ === "string"
      ? __DEPLOY_WATCH_BUILD_ID__
      : "";
  }

  return (
    document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META_NAME}"]`)
      ?.content ?? ""
  );
};

// The statuses that say a file is not there, where asking again would get the same answer.
const GONE_STATUSES = new Set([404, 410]);

/**
 * The build the file at `buildFile` describes; null when the answer is not one. With
 * `untilGone`, null says the file is not there (a 404 or 410, or a body that is not a build
 * file), and any other status that is not OK rejects, as a timeout or the network does.
 */
const fetchBuildFile = async (
  buildFile: string,
  { untilGone = false }: { untilGone?: boolean } = {}
): Promise<BuildFile | null> => {
  const response = await fetch(buildFile, {
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    if (untilGone && !GONE_STATUSES.has(response.status)) {
      throw new Error(`${buildFile} answered ${response.status}`);
    }

    return null;
  }

  if (!untilGone) {
    return parseBuildFile(await response.json());
  }

  // A body that is not JSON (a host that answers every path with the app's page) is not a build
  // file; a body cut off by the timeout or the network is a request that failed.
  try {
    return parseBuildFile(await response.json());
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
};

const sessionStore = (): SessionStore | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

let watch: DeployWatch | null = null;

export interface StartOptions {
  /**
   * Where the live build's id is served. By default `build.json` under the app's `base`, as the
   * Vite plugin tells the browser; an app with a relative `base` (`./`) names it here.
   */
  buildFile?: string;
}

/** Whether the tab shows the page; only ever asked in the browser. */
const pageIsVisible = () => document.visibilityState === "visible";

/** Where the Vite plugin told the browser the live build's file is, where the plugin ran. */
const definedBuildFile = (): string | undefined =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a build without the plugin leaves the define out, so the name is not declared at all and only `typeof` may read it
  typeof __DEPLOY_WATCH_BUILD_FILE__ === "string"
    ? __DEPLOY_WATCH_BUILD_FILE__
    : undefined;

/** The client build's assets directory, as the Vite plugin wrote it into the build. */
const definedAssetsDir = (): string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- as above: only `typeof` may read a define the build left out
  typeof __DEPLOY_WATCH_ASSETS_DIR__ === "string"
    ? __DEPLOY_WATCH_ASSETS_DIR__
    : "assets";

/**
 * Starts this tab's watch. Call it in the browser before the app renders, so a chunk that fails
 * during hydration is known; nothing happens on the server, in development, or a second time.
 */
export const startDeployWatch = ({ buildFile }: StartOptions = {}): void => {
  if (watch || typeof window === "undefined") {
    return;
  }

  const current = pageBuildId();

  if (!current) {
    return;
  }

  const file = buildFile ?? definedBuildFile() ?? BUILD_FILE;

  // The page's build's own copy is in the assets directory beside the live file.
  const ownPath = ownBuildFilePath(definedAssetsDir(), current);

  const ownFile =
    ownPath && `${file.slice(0, file.lastIndexOf("/") + 1)}${ownPath}`;

  const tab = createDeployWatch({
    current,
    fetchLive: () => fetchBuildFile(file),
    fetchOwn: ownFile
      ? () => fetchBuildFile(ownFile, { untilGone: true })
      : undefined,
    now: Date.now,
    storage: sessionStore(),
    load: (href) =>
      href ? window.location.assign(href) : window.location.reload(),
  });

  watch = tab;
  document.addEventListener("visibilitychange", () => {
    if (pageIsVisible()) {
      void tab.check();
    }
  });
  window.addEventListener("focus", () => {
    void tab.check();
  });
  // Back online, a check that failed offline less than a minute ago saw no deploy: check again.
  window.addEventListener("online", () => {
    void tab.check({ retry: true });
  });
  // A reload can leave the page where it is: the user stays at its unsaved-work prompt. A key or
  // pointer pressed after the reload started shows the page is still in use; during a slow reload
  // it only lets the user start it again, which the browser takes as a new navigation. A held key
  // repeats the press that started the reload, and would restart it with every repeat.
  window.addEventListener("pointerdown", () => tab.resume(), true);
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.repeat) {
        tab.resume();
      }
    },
    true
  );
  // A page restored from the back/forward cache is still here, whatever reload it started before
  // it went, and may have slept through any number of deploys.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) {
      return;
    }

    tab.resume();
    void tab.check({ force: true });
  });
  window.setInterval(() => {
    if (pageIsVisible()) {
      void tab.check();
    }
  }, CHECK_INTERVAL_MS);
  // Right after the page loads, the live file most likely still names the page's build. Read it
  // once the browser is idle, so a later deploy can be compared with it.
  const learn = () => tab.learnOwnBuild();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- feature detection: Safari before 18.4 has no `requestIdleCallback`
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(learn, { timeout: IDLE_READ_MS });
  } else {
    window.setTimeout(learn, IDLE_READ_MS);
  }

  // Vite's preload helper announces every chunk (script or stylesheet) that failed to load, then
  // rethrows to the caller; the caller's error screen decides with `recoverFromChunkError`.
  window.addEventListener("vite:preloadError", (event) => {
    // SAFETY: Vite's `vite:preloadError` carries the failure on the event's `payload`, which the
    // DOM's own event type does not name; anything else leaves it undefined.
    const { payload } = event as Event & { payload?: unknown };

    // oxlint-disable-next-line anti-slop/no-known-value-widening -- the payload is whatever the failed import rejected with; this guard is what narrows it
    if (isObject(payload)) {
      failedChunks.add(payload);
    }

    void tab.check({ force: true });
  });
};

/** Whether this tab's watch runs (a deployed build, in the browser). */
export const isWatching = (): boolean => watch !== null;

/** Whether a newer build than this page's is live, with other browser code. */
export const isNewBuildLive = (): boolean => watch?.isNew() ?? false;

/**
 * Whether a newer build is live and changes `module`, as the Vite plugin's `modules` names it:
 * the code the module adds to the page that loads it. True as well while the tab cannot tell:
 * it has no file of its own build, because a deploy came before its first read of `/build.json`
 * and its build's own copy is no longer served.
 */
export const isModuleChanged = (module: string): boolean =>
  watch?.changes(module) ?? false;

/**
 * Reads `/build.json` once soon after the page loads, while it most likely still names the
 * page's own build, so `isModuleChanged` can compare a later deploy with it. Nothing happens once
 * a check has read it. `startDeployWatch` calls it once the browser is idle; call it to read the
 * file sooner.
 */
export const learnPageBuild = (): void => {
  watch?.learnOwnBuild();
};

/**
 * Hides the new-version notice, in every notice of the tab, for the live build: until a later
 * build changes `module` again, or without `module`, until a later build has other browser code.
 * `useNewBuildNotice`'s `dismiss` calls it. The tab still moves onto the new build at its next move.
 */
export const dismissNewBuildNotice = (module?: string): void => {
  watch?.dismiss(module);
};

/**
 * Whether the new-version notice for `module`, or the one for every newer build without it, was
 * dismissed for the live build's code (`dismissNewBuildNotice`).
 */
export const isNewBuildNoticeDismissed = (module?: string): boolean =>
  watch?.isDismissed(module) ?? false;

/**
 * Calls `listener` once a newer build is live, and again when the tab learns more (a later
 * deploy, or its own build's file, either of which can change `isModuleChanged`) and when a
 * notice is dismissed.
 */
export const subscribeToNewBuild = (listener: () => void): (() => void) =>
  watch?.subscribe(listener) ??
  (() => {
    // No watch runs: there is nothing to unsubscribe from.
  });

/** Moves the tab onto the live build: `href` as a whole page, or this page again. */
export const reloadOntoNewBuild = (href?: string): void => {
  watch?.reload(href);
};

/**
 * True once the tab is reloading, onto a new build or after one of its chunks failed to load;
 * errors until the page is gone are expected, not faults. False again once the page is evidently
 * still here: at the first key or pointer press after the reload started (the user stayed at the
 * unsaved-work prompt), or when the back/forward cache brings it back.
 */
export const isReloadingOntoNewBuild = (): boolean =>
  watch?.isReloading() ?? false;

/**
 * Calls `listener` when `isReloadingOntoNewBuild()` changes: a reload starts, or the page turns out
 * to be still here. An error screen that shows nothing while the page reloads shows its error then.
 */
export const subscribeToReload = (listener: () => void): (() => void) =>
  watch?.subscribeToReload(listener) ??
  (() => {
    // No watch runs: there is nothing to unsubscribe from.
  });

/**
 * For an error screen: resolves true when `error` is a chunk that did not load and the page is
 * reloading (show nothing): onto the newer build that replaced the page's, or, the first time a
 * chunk of the live build fails in this tab within `LOOP_GUARD_MS`, onto that build again. False
 * when the screen should show, which includes a tab whose session storage refuses the loop guard:
 * nothing would stop a reload loop there.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the value an error screen caught, which no schema describes
export const recoverFromChunkError = async (error: unknown): Promise<boolean> =>
  (await watch?.recover(error)) ?? false;

/**
 * Makes the router's next move to another page a whole-page load once a newer build is live. In
 * the browser it follows the router whether the watch starts before or after (`startDeployWatch`):
 * each move asks the watch that runs then. Nothing happens on the server.
 */
export const followNewBuild = (router: NavigationEvents): (() => void) => {
  if (typeof window === "undefined") {
    return () => {
      // Nothing followed the router on the server: there is nothing to unfollow.
    };
  }

  return router.subscribe("onBeforeNavigate", (event) =>
    watch?.beforeNavigate(router, event)
  );
};
