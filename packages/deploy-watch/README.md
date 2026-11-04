# @rivi-software/deploy-watch

[![npm version](https://img.shields.io/npm/v/@rivi-software/deploy-watch?label=npm&color=0b6b3a)](https://www.npmjs.com/package/@rivi-software/deploy-watch) [![CI status](https://img.shields.io/github/actions/workflow/status/rivi-software/tools/ci.yml?branch=main&label=CI)](https://github.com/rivi-software/tools/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-0b6b3a)](LICENSE)

Moves a browser tab that was open across a deploy onto the new build, at a moment that loses nothing.

A deploy serves only its own hashed chunks. A tab still running the previous build keeps calling the server with old code. It also fails on the next chunk it loads lazily, unless the old files are still served; on Cloudflare Workers, [`@rivi-software/cloudflare-deploy`](https://github.com/rivi-software/tools/tree/main/packages/cloudflare-deploy#skew-protection) keeps them for seven days.

This package notices the deploy in the browser and moves the tab on:
- the next navigation loads the whole page
- a notice can offer the reload, only when the deploy changed the module on screen if you name your modules
- an error screen that caught a missing chunk reloads instead of showing

A deploy that leaves every browser file as it was (a server-only commit, in an app whose browser code does not carry the commit) does none of these.

## Install

```bash
npm install @rivi-software/deploy-watch
```

It needs a Vite build (6, 7 or 8). The React entry point needs React 18 or 19. It is ESM only.

## Usage

```ts
// vite.config.ts
import { deployWatch } from "@rivi-software/deploy-watch/vite";

export default defineConfig({ plugins: [/* … */ deployWatch()] });
```

```tsx
import {
  followNewBuild,
  recoverFromChunkError,
  startDeployWatch,
} from "@rivi-software/deploy-watch";
import { BuildMeta, useChunkErrorRecovery, useNewBuildNotice } from "@rivi-software/deploy-watch/react";

// The browser entry, before the app renders, and the router (TanStack Router).
startDeployWatch();
const router = createRouter({ routeTree });
if (typeof window !== "undefined") followNewBuild(router);

// The root document.
<head>
  <HeadContent />
  <BuildMeta />
</head>;

// An error component.
function RouteCrash({ error }: ErrorComponentProps) {
  if (useChunkErrorRecovery(error)) return null;
  return <CrashScreen error={error} />;
}

// A notice, anywhere in the app.
function NewVersionNotice() {
  const notice = useNewBuildNotice();
  // Or, with modules named (below), only once a deploy changed the one on screen:
  // const notice = useNewBuildNotice({ module: moduleAt(useLocation().pathname) });
  if (!notice.show) return null;
  return (
    <aside role="status">
      A new version is available. <button onClick={notice.reload}>Reload</button>
      <button onClick={notice.dismiss}>Later</button>
    </aside>
  );
}
```

To report errors, report only what stays: `recoverFromChunkError(error).then((reloading) => reloading || report(error))`.

### A notice per module

Every deploy reaches an open tab at its next move to another page. The notice interrupts someone who stays put, so it can wait until a deploy changed the module they are in. Name your modules in the plugin: it is called for every file the browser loads lazily, with the file's path from the project root and the files that import it lazily, and returns a module's name, several, or nothing.

```ts
// vite.config.ts: one module per route file under src/routes/app/ (TanStack Router splits each).
deployWatch({
  modules: ({ id }) => /^src\/routes\/app\/([^./]+)\./.exec(id)?.[1],
});
// Or by the file that loads a section's screens: ({ importers }) => sectionsLoadedBy(importers)
```

Then give the notice the module the page shows: `useNewBuildNotice({ module: "inbox" })`. It shows once a deploy changed that module's code, and also while the tab cannot tell (below). `{ module: null }` is a page in no module, where it never shows. A deploy that changed other code still reaches the tab at its next move.

## How it works

- **The build's id.** The Vite plugin gives each build the commit CI builds: `WORKERS_CI_COMMIT_SHA` on Cloudflare Workers Builds, GitHub's `GITHUB_SHA` otherwise, or the `buildId` option.
  - The server bundle gets the id as a define.
  - The browser's assets get `build.json` (`{ "id": "<commit>", "client": "<fingerprint>", "modules": { "<name>": "<fingerprint>" } }`), served as a static file under Vite's `base`: `/build.json`, or `/app/build.json` with `base: "/app/"`.
  - The browser bundle never holds the id, so a commit that changes no browser code renames no chunk, and two builds of one commit stay byte for byte the same. It only learns where `build.json` is.
  - A relative `base` (`./`) or a `base` on another host names no fixed path, so name it yourself: `startDeployWatch({ buildFile: "/where/build.json" })`.
  - The plugin also bundles this package into server builds (`resolve.noExternal`): a define reaches only bundled code, and Vite leaves dependencies external there by default.
  - The dev server and a local build have no id, and nothing runs.
- **The fingerprints.**
  - `client` covers the name and the exact content of every file of the browser build but source maps and Vite's manifests in `.vite/`. Two builds have the same `client` only when they serve the same files, so a tab on one can load every chunk it needs from the other. An app that writes its commit into its browser code gets a new `client` with every commit.
  - With `modules`, each named module's fingerprint covers what its lazily loaded files bring beyond the page that loads them: the files they import, statically or lazily, less the entry's own files and what the importers' chunks import statically. Code every page already has, such as the shell's own components, is in no module.
  - A module's fingerprint decides only whether the notice shows, so it reads what the code does. Rollup renames a chunk when any chunk it imports, even lazily, was renamed, so one changed file renames most of a bundle. The module fingerprint reads each file's content with every name of a file in the bundle taken out, and with the build's id too (the whole id, or its first seven characters alone), since an app may write its release into its code for error reports. A `buildId` shorter than seven characters, such as a CI build number, is not taken out.
- **The page's id.** `BuildMeta` renders `<meta name="deploy-watch-build">` in the document's head on the server. In the browser it reads the tag back, so hydration matches.
- **The check.** `startDeployWatch()` reads `build.json` (`no-store`, without cookies, giving up after 10 s):
  - when the tab comes back into view, gets focus or comes back online, at most once a minute
  - every ten minutes while it is visible
  - after a back/forward-cache restore
  - at once when Vite's preload helper reports a chunk that failed (`vite:preloadError`)

  Once the live build has other browser code than the page's, it is new, and it stays new for the tab; later checks keep reading `build.json`, since a later deploy may change another module. An answer that is not a build file, such as a sign-in page in its place, changes nothing, so serve `build.json` to visitors who are not signed in.
- **The page's own build.** The page knows only its build's id. The first answer that names that id is its own `build.json`, and once the tab has it, a build with the same `client` is not new. A notice for a module (`useNewBuildNotice({ module })`) reads the file once right away (`learnPageBuild`), while it most likely still names the page's own build. A tab that never read it, because a deploy came first, takes any other id as new and every module as changed, as if no fingerprints were there.
- **The move.** Once the build is new:
  - `followNewBuild(router)` makes the router's next move to another path a whole-page load. It runs on `onBeforeNavigate`, after the router's blockers let the move through, and flushes the history's queued address change before it reloads, so the destination loads with one history entry. A move within the page (its search or hash) stays in place.
  - `useNewBuildNotice()` gives a notice its state: `show`, `dismiss` and `reload`. A reload on a page with unsaved work asks first, through the page's own `beforeunload`. With `{ module }`, `show` waits until the new build changes that module (`isModuleChanged`).
  - `useChunkErrorRecovery(error)` (React) or `recoverFromChunkError(error)` lets an error screen that caught a missing chunk reload onto the new build instead of showing. While it checks, the screen renders a placeholder.
  - A chunk can also fail while the page's build, or one with its browser code, is still the live one. The file is on the server, so the browser failed to fetch it (a dropped connection), and Chromium keeps that failure for the document's life ([whatwg/html#6768](https://github.com/whatwg/html/issues/6768)). The page then reloads onto the same build, once per build in a tab. A second failure is a real fault, and the screen shows it. So does a failure while `/build.json` does not answer (offline, where a reload would leave the app) or while the tab has no session storage.
  - A failed hover or idle preload only starts the check. The page never reloads under someone reading or typing.
- **The loop guard.** Before it reloads, the tab writes the build it reloads for into its session storage (`deploy-watch:reloaded-for`). If the page that comes back still runs another build (a server that renders the old build after the assets moved on), that build is not new to the tab again. Before the reload for a chunk of the live build, the tab writes that build to `deploy-watch:chunk-retry-for`; without that write, the reload does not happen.
- `isReloadingOntoNewBuild()` is true once either reload has started. Error reporting can drop what fails until the page is gone.

## Without a client router (Astro)

Links load whole pages, so they reach the new build on their own. A page can still miss the code it loads later: an island that hydrates on scroll, or a chunk a dynamic import brings. Add the plugin under `vite.plugins` in `astro.config.mjs`, then write the meta from the base layout and hand each failure to `recoverFromChunkError`:

```astro
---
import { BUILD_META_NAME, pageBuildId } from "@rivi-software/deploy-watch";
const build = pageBuildId();
---

{build && <meta name={BUILD_META_NAME} content={build} />}

<script>
  import { recoverFromChunkError, startDeployWatch } from "@rivi-software/deploy-watch";

  startDeployWatch();
  // Astro's island loader retries a failed import once, then reports it here.
  document.addEventListener("astro:hydration-error", (event) => {
    void recoverFromChunkError((event as CustomEvent<{ error?: unknown }>).detail?.error);
  });
  window.addEventListener("vite:preloadError", (event) => {
    void recoverFromChunkError((event as Event & { payload?: unknown }).payload);
  });
</script>
```

### With Astro's ClientRouter

ClientRouter remembers the scripts it ran by address, and a deploy renames every bundled script. Swapping in a page of another build would run that build's scripts beside the page's own: analytics a second time, every `astro:page-load` listener twice. The router fetches the next page before it swaps, so compare that page's meta with this one's and cancel the preparation when they differ. A cancelled preparation makes the router load the address itself, back and forward included. No watch is needed.

```astro
<script>
  import { BUILD_META_NAME, pageBuildId } from "@rivi-software/deploy-watch";

  const build = pageBuildId();
  document.addEventListener("astro:before-preparation", (event) => {
    // The loader sends a form; loading the address afterwards would drop what it answered.
    if (event.formData) return;
    const load = event.loader;
    event.loader = async () => {
      await load();
      if (event.defaultPrevented || event.signal.aborted) return;
      const meta = event.newDocument.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META_NAME}"]`);
      if ((meta?.content ?? "") !== build) event.preventDefault();
    };
  });
</script>
```

## Exports

From `@rivi-software/deploy-watch` (browser and server; on the server, and in a build without an id, each call does nothing):

| Export | What |
| --- | --- |
| `startDeployWatch({ buildFile? })` | Starts the tab's watch; call it in the browser before the app renders |
| `followNewBuild(router)` | Makes the router's next move to another path a whole-page load once the build is new; returns the unsubscribe |
| `recoverFromChunkError(error)` | Resolves `true` when `error` is a missing chunk and the page is reloading, `false` when the error screen should show |
| `isChunkLoadError(error)` | Whether `error` is a chunk of script or style that did not load |
| `isNewBuildLive()`, `subscribeToNewBuild(listener)` | Whether a newer build with other browser code is live; a listener for the moment it is, and for what the tab learns after (returns the unsubscribe) |
| `isModuleChanged(module)` | Whether a newer build is live and changes `module`, or the tab cannot tell |
| `learnPageBuild()` | Reads `build.json` once, unless a check already has, so `isModuleChanged` can compare later deploys with the page's own build |
| `reloadOntoNewBuild(href?)` | Loads `href`, or this page again, on the live build |
| `isReloadingOntoNewBuild()` | Whether a reload has started, so errors until the page is gone can go unreported |
| `isWatching()` | Whether the watch runs: a deployed build, in the browser |
| `pageBuildId()` | The page's build id: the build's on the server, the meta tag's in the browser; empty without one |
| `parseBuildFile(body)` | The `BuildFile` a parsed `build.json` describes (`id`, and `client` and `modules` when it has them), or `null` |
| `createDeployWatch(deps)` | The watch over injected dependencies (`current`, `fetchLive`, `now`, `storage`, `load`), for tests and other hosts |
| `BUILD_META_NAME`, `BUILD_FILE` | `deploy-watch-build` and `/build.json` |
| `CHECK_SPACING_MS`, `CHECK_INTERVAL_MS` | A minute between checks the tab's own activity starts; ten minutes between checks while it is visible |
| `RELOADED_FOR_KEY`, `CHUNK_RETRY_KEY` | The session storage keys of the [loop guard](#how-it-works) |
| Types | `BuildFile`, `StartOptions`, `DeployWatch`, `DeployWatchDeps`, `NavigationEvent`, `NavigationEvents` |

From `@rivi-software/deploy-watch/react` (server and browser):

| Export | What |
| --- | --- |
| `BuildMeta` | The `<meta>` with the page's build id, for the document's `<head>` |
| `useNewBuildNotice({ module? })` | `{ show, dismiss, reload }` for a new-version notice; with `module`, it shows only once a deploy changed that module |
| `useChunkErrorRecovery(error)` | `true` while an error screen should render a placeholder instead of the error |
| Types | `NewBuildNoticeOptions` |

From `@rivi-software/deploy-watch/vite` (Vite config):

| Export | What |
| --- | --- |
| `deployWatch({ buildId?, modules? })` | The Vite plugin; an empty `buildId` turns the watch off, and `modules` names the module of each lazily loaded file |
| `buildFileUnder(base)` | Where `build.json` is served under a `base` |
| `PACKAGE_PATTERN` | What the plugin bundles into server builds |
| Types | `DeployWatchOptions`, `LazyFile` |

## Development

The tests in `tests/` cover the watch over injected dependencies: the spacing between checks, the shared request, the loop guard, the reload, chunk recovery, the router's moves, the page's own build and module changes. They also cover the Vite plugin's hooks, a real server build against the package as npm installs it, and real browser builds whose fingerprints change only with the code each module brings. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 RIVI Software.

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>Part of <a href="https://github.com/rivi-software/tools#readme">RIVI tools</a>, the packages <a href="https://rivi.software">RIVI Software</a> builds its own apps with.</sub>
</p>
