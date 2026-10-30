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
 *
 * A failed hover or idle preload only triggers the check: the page reloads when it needs the
 * code, never under someone reading or typing. A chunk that fails while the page's build is
 * still the live one is on the server, so the browser failed to fetch it: the error screen
 * reloads the page once for that build, and a second failure is a real fault and stays the
 * screen's. In development, and in any build without an id, nothing runs.
 */

declare const __DEPLOY_WATCH_BUILD_ID__: string | undefined;

/** The `<meta>` the server writes the page's build id into. */
export const BUILD_META_NAME = "deploy-watch-build";
/** The live build's id, from the static assets: `{ "id": "<commit>" }`. */
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

export type DeployWatchDeps = {
  /** The build this page runs. */
  current: string;
  /** The live build's id; null when the answer is not one. */
  fetchLive: () => Promise<string | null>;
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
  let live: string | null = null;
  // What the last check read: the live build's id, or null when `/build.json` did not answer.
  let answered: string | null = null;
  let pending: Promise<boolean> | null = null;
  let reloading = false;
  const listeners = new Set<() => void>();

  /** Whether a newer build is live. `force` skips the spacing, for a chunk that failed. */
  function check({ force = false }: { force?: boolean } = {}): Promise<boolean> {
    if (live) return Promise.resolve(true);
    if (pending) return pending;
    if (!force && now() - lastCheck < CHECK_SPACING_MS) return Promise.resolve(false);
    lastCheck = now();
    pending = fetchLive()
      .catch(() => null)
      .then((id) => {
        pending = null;
        answered = id;
        if (id && id !== current && id !== reloadedFor) {
          live = id;
          for (const listener of listeners) listener();
        }
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
    remember(RELOADED_FOR_KEY, live);
    load(href);
  }

  return {
    check,
    reload,
    isNew: () => live !== null,
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
      // `/build.json` names the page's own build, so the chunk is on the server and the browser
      // failed to fetch it. Chromium keeps a failed module import for the life of the document
      // (whatwg/html#6768), so only a new page fetches it again. The tab reloads once for its
      // build; a second failure, an unanswered check (offline) or no storage to remember the
      // first reload in is the screen's.
      if (answered !== current || retriedFor === current || !remember(CHUNK_RETRY_KEY, current))
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

/** The id in a `/build.json` body, or null for anything else. */
export function parseBuildFile(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("id" in body)) return null;
  return typeof body.id === "string" && body.id ? body.id : null;
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

async function fetchLiveBuild(): Promise<string | null> {
  const response = await fetch(BUILD_FILE, {
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

/**
 * Starts this tab's watch. Call it in the browser before the app renders, so a chunk that fails
 * during hydration is known; nothing happens on the server, in development, or a second time.
 */
export function startDeployWatch(): void {
  if (watch || typeof window === "undefined") return;
  const current = pageBuildId();
  if (!current) return;
  const tab = createDeployWatch({
    current,
    fetchLive: fetchLiveBuild,
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

/** Whether a newer build than this page's is live. */
export function isNewBuildLive(): boolean {
  return watch?.isNew() ?? false;
}

/** Calls `listener` once a newer build is live. */
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
