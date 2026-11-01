/**
 * A tab keeps running the build it loaded, and a deploy serves only its own hashed chunks. This
 * notices the deploy and moves the tab onto it at a moment that loses nothing:
 *
 * - The page's build id is in its `<meta name="deploy-watch-build">` (the server writes it,
 *   `BuildMeta` in `./react`); the live build's is in `/build.json` (the Vite plugin, `./vite`,
 *   writes it into the static assets, so reading it costs no server request).
 * - `startDeployWatch` reads `/build.json` when the tab comes back into view or gets focus (at most
 *   once a minute), every ten minutes while it is visible, and at once when a chunk fails to load.
 * - Once a newer build is live, the next move to another page loads the whole page
 *   (`followNewBuild`), after the app's unsaved-work guards have run; a notice can offer the
 *   reload (`useNewBuildNotice` in `./react`); and an error screen that caught a missing chunk
 *   reloads onto the new build instead of showing (`recoverFromChunkError`).
 * - `/build.json` also carries the browser code's fingerprint and each named module's. A deploy
 *   that leaves the page's browser code as it was is not new to the tab, and a notice for a
 *   module waits until a deploy changes that module (`isModuleChanged`).
 *
 * A failed hover or idle preload only triggers the check: the page reloads when it needs the
 * code, never under someone reading or typing. A chunk that fails while the page's build is
 * still the live one is on the server, so the browser failed to fetch it: the error screen
 * reloads the page once for that build, and a second failure is a real fault and stays the
 * screen's. In development, and in any build without an id, nothing runs.
 */

declare const __DEPLOY_WATCH_BUILD_ID__: string | undefined;
declare const __DEPLOY_WATCH_BUILD_FILE__: string | undefined;

/** The `<meta>` the server writes the page's build id into. */
export const BUILD_META_NAME = "deploy-watch-build";
/**
 * The live build's file, from the static assets (`BuildFile`). This is where it is with Vite's
 * default `base`; the Vite plugin tells the browser where it is under another one.
 */
export const BUILD_FILE = "/build.json";
/** The fewest milliseconds between two checks a tab's own activity starts; a failed chunk checks at once. */
export const CHECK_SPACING_MS = 60_000;
/** How often a visible tab checks on its own. */
export const CHECK_INTERVAL_MS = 10 * 60_000;
/** The build this tab last reloaded for, in its session storage. */
export const RELOADED_FOR_KEY = "deploy-watch:reloaded-for";
/** The live build this tab last reloaded on because one of its chunks failed, in its session storage. */
export const CHUNK_RETRY_KEY = "deploy-watch:chunk-retry-for";

type SessionStore = Pick<Storage, "getItem" | "setItem">;

/** What `/build.json` says about a build; the Vite plugin writes it. */
export type BuildFile = {
  /** The build's id: the commit it was built from. */
  id: string;
  /** Its browser code's fingerprint: the same in every build whose browser code is the same. */
  client?: string;
  /** Each named module's fingerprint: the code it adds to the page that loads it. */
  modules?: Readonly<Record<string, string>>;
};

export type DeployWatchDeps = {
  /** The build this page runs. */
  current: string;
  /** The live build's file; null when the answer is not one. */
  fetchLive: () => Promise<BuildFile | null>;
  now: () => number;
  /** The tab's session storage; null where the browser refuses it. */
  storage: SessionStore | null;
  /** Loads `href` as a whole page, or this page again without one. */
  load: (href?: string) => void;
};

/** The navigation event `followNewBuild` reads (TanStack Router's `onBeforeNavigate`). */
export type NavigationEvent = { fromLocation?: unknown; pathChanged: boolean };

/** The router `followNewBuild` follows (TanStack Router's). */
export type NavigationEvents = {
  subscribe: (
    eventType: "onBeforeNavigate",
    listener: (event: NavigationEvent) => void,
  ) => () => void;
  /** Its history, which queues the address change a move makes; `flush` writes it at once. */
  history: { flush?: () => void };
};

export type DeployWatch = ReturnType<typeof createDeployWatch>;

/** One tab's watch, over the dependencies `startDeployWatch` gives it in the browser. */
export function createDeployWatch({ current, fetchLive, now, storage, load }: DeployWatchDeps) {
  // A build this tab already reloaded for and still did not get (a server that renders the old
  // build after the assets moved on) is not new to it: reloading for it again would loop.
  const reloadedFor = readStorage(storage, RELOADED_FOR_KEY);
  // The build this tab already reloaded on once because one of its own chunks failed to load.
  const retriedFor = readStorage(storage, CHUNK_RETRY_KEY);
  // The page has just loaded the build it runs, so the first check waits like any other.
  let lastCheck = now();
  let asked = false;
  // The page's own build, as `/build.json` described it while it was live.
  let own: BuildFile | null = null;
  // The newer build's file once one is live, the latest such answer.
  let live: BuildFile | null = null;
  // Whether the last check read a build with the page's own browser code; false when
  // `/build.json` did not answer.
  let answeredOwnCode = false;
  let pending: Promise<boolean> | null = null;
  let reloading = false;
  const listeners = new Set<() => void>();

  /**
   * Whether `build` runs the page's browser code: the page's own build, or a later one whose
   * browser code is the same (a deploy that changed only the server). Unknown until the tab has
   * read its own build's file, and then the build counts as new.
   */
  function sameCode(build: BuildFile): boolean {
    return build.id === current || (!!own?.client && build.client === own.client);
  }

  /**
   * Whether a newer build is live. `force` skips the spacing, for a chunk that failed. Once a
   * newer build is live, it stays new for the tab, and later checks keep reading `/build.json`
   * for a deploy after it, which may change another module.
   */
  function check({ force = false }: { force?: boolean } = {}): Promise<boolean> {
    // A chunk that failed on a page a newer build replaced needs no answer: the page reloads.
    if (live && force) return Promise.resolve(true);
    if (pending) return pending;
    if (!force && now() - lastCheck < CHECK_SPACING_MS) return Promise.resolve(live !== null);
    lastCheck = now();
    asked = true;
    pending = fetchLive()
      .catch(() => null)
      .then((answer) => {
        pending = null;
        let changed = false;
        if (answer?.id === current && !own) {
          own = answer;
          changed = true;
        }
        answeredOwnCode = answer !== null && sameCode(answer);
        if (answer && !answeredOwnCode && answer.id !== reloadedFor && answer.id !== live?.id) {
          live = answer;
          changed = true;
        }
        if (changed) for (const listener of listeners) listener();
        return live !== null;
      });
    return pending;
  }

  /** Writes `build` under `key` in the tab's session storage; false where the browser refuses it. */
  function remember(key: string, build: string): boolean {
    if (!storage) return false;
    try {
      storage.setItem(key, build);
      return true;
    } catch {
      return false;
    }
  }

  /** Moves the tab onto the live build: `href` as a whole page, or this page again. */
  function reload(href?: string) {
    if (reloading || !live) return;
    reloading = true;
    // Without storage the reload still happens; only the loop guard is lost.
    remember(RELOADED_FOR_KEY, live.id);
    load(href);
  }

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
      if (!live) return false;
      if (!own?.modules || !live.modules) return true;
      return own.modules[module] !== live.modules[module];
    },
    /**
     * Reads `/build.json` once, unless a check already has. Soon after the page loads it still
     * names the page's own build, so a later deploy can be compared with it module by module.
     */
    learnOwnBuild() {
      if (!asked) void check({ force: true });
    },
    isReloading: () => reloading,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * For an error screen: true when `error` is a chunk that did not load and the tab is reloading,
     * onto the new build or, once per build, onto its own.
     */
    async recover(error: unknown): Promise<boolean> {
      if (!isChunkLoadError(error)) return false;
      if (await check({ force: true })) {
        reload();
        return true;
      }
      if (reloading) return true;
      // `/build.json` names the page's own browser code, so the chunk is on the server and the
      // browser failed to fetch it. Chromium keeps a failed module import for the life of the
      // document (whatwg/html#6768), so only a new page fetches it again. The tab reloads once for
      // its build; a second failure, an unanswered check (offline) or no storage to remember the
      // first reload in is the screen's.
      if (!answeredOwnCode || retriedFor === current || !remember(CHUNK_RETRY_KEY, current))
        return false;
      reloading = true;
      load();
      return true;
    },
    /**
     * The router's next move to another page loads the whole page once a newer build is live.
     * `onBeforeNavigate` fires once the router's blockers let the move through, with the address
     * change still queued in its history: flushed, the address is the destination, and reloading
     * lands there with one history entry. A move within the page (its search or hash) and the
     * first load stay as they are.
     */
    follow(router: NavigationEvents) {
      return router.subscribe("onBeforeNavigate", (event) => {
        if (!event.fromLocation || !event.pathChanged || !live) return;
        router.history.flush?.();
        reload();
      });
    },
  };
}

function readStorage(storage: SessionStore | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** The build a `/build.json` body describes, or null for anything else. */
export function parseBuildFile(body: unknown): BuildFile | null {
  if (!body || typeof body !== "object") return null;
  const { id, client, modules } = body as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  const build: BuildFile = { id };
  if (typeof client === "string" && client) build.client = client;
  if (modules && typeof modules === "object" && !Array.isArray(modules))
    build.modules = Object.fromEntries(
      Object.entries(modules).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  return build;
}

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
export function isChunkLoadError(error: unknown): boolean {
  if (error && typeof error === "object" && failedChunks.has(error)) return true;
  const message = error instanceof Error ? error.message : "";
  return chunkErrorMessages.some((prefix) => message.startsWith(prefix));
}

/**
 * The build this page runs: on the server, the id the Vite plugin gave the build; in the browser,
 * the one the server wrote into the page. Empty in development and in a build without an id.
 */
export function pageBuildId(): string {
  if (typeof document === "undefined")
    return typeof __DEPLOY_WATCH_BUILD_ID__ === "string" ? __DEPLOY_WATCH_BUILD_ID__ : "";
  return document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META_NAME}"]`)?.content ?? "";
}

async function fetchLiveBuild(buildFile: string): Promise<BuildFile | null> {
  const response = await fetch(buildFile, {
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok ? parseBuildFile(await response.json()) : null;
}

function sessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let watch: DeployWatch | null = null;

export type StartOptions = {
  /**
   * Where the live build's id is served. By default `build.json` under the app's `base`, as the
   * Vite plugin tells the browser; an app with a relative `base` (`./`) names it here.
   */
  buildFile?: string;
};

/**
 * Starts this tab's watch. Call it in the browser before the app renders, so a chunk that fails
 * during hydration is known; nothing happens on the server, in development, or a second time.
 */
export function startDeployWatch({ buildFile }: StartOptions = {}): void {
  if (watch || typeof window === "undefined") return;
  const current = pageBuildId();
  if (!current) return;
  const file =
    buildFile ??
    (typeof __DEPLOY_WATCH_BUILD_FILE__ === "string" ? __DEPLOY_WATCH_BUILD_FILE__ : BUILD_FILE);
  const tab = createDeployWatch({
    current,
    fetchLive: () => fetchLiveBuild(file),
    now: Date.now,
    storage: sessionStore(),
    load: (href) => (href ? window.location.assign(href) : window.location.reload()),
  });
  watch = tab;
  const visible = () => document.visibilityState === "visible";
  document.addEventListener("visibilitychange", () => {
    if (visible()) void tab.check();
  });
  window.addEventListener("focus", () => void tab.check());
  window.addEventListener("online", () => void tab.check());
  // A page restored from the back/forward cache may have slept through any number of deploys.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void tab.check({ force: true });
  });
  window.setInterval(() => {
    if (visible()) void tab.check();
  }, CHECK_INTERVAL_MS);
  // Vite's preload helper announces every chunk (script or stylesheet) that failed to load, then
  // rethrows to the caller; the caller's error screen decides with `recoverFromChunkError`.
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (payload && typeof payload === "object") failedChunks.add(payload);
    void tab.check({ force: true });
  });
}

/** Whether this tab's watch runs (a deployed build, in the browser). */
export function isWatching(): boolean {
  return watch !== null;
}

/** Whether a newer build than this page's is live, with other browser code. */
export function isNewBuildLive(): boolean {
  return watch?.isNew() ?? false;
}

/**
 * Whether a newer build is live and changes `module`, as the Vite plugin's `modules` names it:
 * the code the module adds to the page that loads it. True as well while the tab cannot tell,
 * for instance before it has read its own build's file (`learnPageBuild`).
 */
export function isModuleChanged(module: string): boolean {
  return watch?.changes(module) ?? false;
}

/**
 * Reads `/build.json` once soon after the page loads, while it most likely still names the
 * page's own build, so `isModuleChanged` can compare a later deploy with it. Nothing happens once
 * a check has read it. `useNewBuildNotice({ module })` calls it.
 */
export function learnPageBuild(): void {
  watch?.learnOwnBuild();
}

/**
 * Calls `listener` once a newer build is live, and again when the tab learns more: a later
 * deploy, or its own build's file, either of which can change `isModuleChanged`.
 */
export function subscribeToNewBuild(listener: () => void): () => void {
  return watch?.subscribe(listener) ?? (() => {});
}

/** Moves the tab onto the live build: `href` as a whole page, or this page again. */
export function reloadOntoNewBuild(href?: string): void {
  watch?.reload(href);
}

/**
 * True once the tab is reloading, onto a new build or after one of its chunks failed to load;
 * errors until the page is gone are expected, not faults.
 */
export function isReloadingOntoNewBuild(): boolean {
  return watch?.isReloading() ?? false;
}

/**
 * For an error screen: resolves true when `error` is a chunk that did not load and the page is
 * reloading (show nothing): onto the newer build that replaced the page's, or, the first time a
 * chunk of the live build fails in this tab, onto that build again. False when the screen should
 * show.
 */
export function recoverFromChunkError(error: unknown): Promise<boolean> {
  return watch?.recover(error) ?? Promise.resolve(false);
}

/** Makes the router's next move to another page a whole-page load once a newer build is live. */
export function followNewBuild(router: NavigationEvents): () => void {
  return watch?.follow(router) ?? (() => {});
}
