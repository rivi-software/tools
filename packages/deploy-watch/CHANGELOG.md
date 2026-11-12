# @rivi-software/deploy-watch

## 0.7.2

### Patch Changes

- f186908: An error screen that caught a missing chunk now reloads onto a newer build only once the tab has written its loop guard to session storage. Where the browser refuses session storage, such as Safari with site data blocked or some embedded web views, `recoverFromChunkError(error)` resolves `false` and `useChunkErrorRecovery(error)` shows the error. Before, the screen reloaded without the guard. On a host that served the old page after the assets moved on, the tab came back on the old build, found the newer one again at the next failed chunk and reloaded again, with nobody touching it. A reload from the notice, and the whole-page load at a move to another page, still happen without storage. Nothing changes where session storage works.

## 0.7.1

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.7.0

### Minor Changes

- 20950d1: A tab now reads `/build.json` when the browser comes back online, even less than a minute after a read that got no answer. Before, the minute between checks counted from that failed read too, so coming back online soon after it checked nothing, and a deploy that went live meanwhile showed no notice and gave no whole-page load at the next move until the tab got focus, came back into view or reached its ten-minute check. Coming back online after a read that did get an answer still waits for the minute, and a burst of events still shares one request.

## 0.6.0

### Minor Changes

- 7b559e6: The loop guards in a tab's session storage now hold for ten minutes (`LOOP_GUARD_MS`) instead of the whole session. Before, a reload onto a new build that landed on a page of the old build, such as one a cache still served for a minute after the deploy, left that build never new to the tab again: hours later, with the cache long expired, the tab still ran the old build, with no notice and no whole-page load at its next move, until another deploy. And a chunk of the live build that failed (a dropped connection) reloaded the page once per build in the whole session, so a second dropped connection hours later showed the error screen, though a reload would have fixed it.
  
  Each guard now stores the time with the build id, and a later check tries the reload again once the guard is ten minutes old. A reload loop takes seconds, so the guards still stop one, and a cache that serves the old page for longer costs at most one reload in ten minutes. A bare build id, as earlier versions wrote it, holds for ten minutes from when the page loaded, so tabs open across the upgrade keep their protection.
- 9563a9f: A tab now learns its own build's fingerprints even when a deploy lands before it reads `build.json`. Before, it learned them only from a `build.json` that still named its build, and its first check waited at least a minute after the page loaded. A tab that missed that read took every other build as new and every module as changed: a tab opened shortly before a server-only deploy loaded the whole page at its next move for nothing, and a notice for a module showed for a deploy that did not touch that module.
  
  The Vite plugin now also writes a copy of `build.json` under the build's own name in the assets directory, `assets/deploy-watch-<id>.json`. When a check finds another build in `build.json` and the tab has no file of its own yet, it reads that copy once. A host that keeps a replaced build's assets serves it after the deploy; `@rivi-software/cloudflare-deploy`'s skew protection keeps it for seven days. The browser builds the name from the page's id, so the browser code stays the same across commits, and the copy is in no fingerprint. An id that is not a plain file name gets no copy.
  
  `startDeployWatch()` also reads `build.json` once soon after the page loads, when the browser is idle, which costs one static-asset request per page load. This helps on hosts that keep no replaced files. `useNewBuildNotice({ module })` no longer calls `learnPageBuild()` itself, since the watch now does that read.

## 0.5.0

### Minor Changes

- 6466844: `followNewBuild(router)` follows the router whether `startDeployWatch()` runs before or after it. Before, called first, it returned a no-op and never followed, with no warning, so every tab stayed on the old build at its moves to another page until a chunk failed. In TanStack Start, where `getRouter()` and the client entry's `startDeployWatch()` sit in different files, that order was easy to get wrong. Now it subscribes in the browser at once and asks the watch that runs at each move. On the server it still does nothing, so the `typeof window` guard around it is no longer needed.

## 0.4.1

### Patch Changes

- 221c833: `useChunkErrorRecovery(error)` checks each error an error screen renders. Before, it decided on the first render only, so a screen that stayed mounted while its error changed kept that first answer: a chunk error after another kind of error showed instead of reloading the page, and so did a chunk error after one whose check had shown the screen. Now another error starts the check over, and a check still running for an earlier error no longer decides for the new one.

## 0.4.0

### Minor Changes

- 41fbc78: The new-version notice shows again for a later deploy after a dismissal. Before, `useNewBuildNotice().dismiss` set a flag in that one component, so a dismissed notice stayed hidden for every later deploy, even one that changed the module on screen again, and a notice that mounted again showed again for the build it was dismissed for. The tab now remembers what was dismissed, and every notice reads it: the live build, or with `{ module }`, that module's fingerprint in it. The notice shows again once a later build is live with other browser code, or with `{ module }`, once a later build changes that module again. `dismissNewBuildNotice(module?)` and `isNewBuildNoticeDismissed(module?)` do the same for a notice that is not React's, and `subscribeToNewBuild` listeners hear of a dismissal.

## 0.3.0

### Minor Changes

- e7d2bdd: The Vite plugin now also reads the build's id from `CF_PAGES_COMMIT_SHA` (Cloudflare Pages) and `CI_COMMIT_SHA` (GitLab CI, and the services that use its name), after `WORKERS_CI_COMMIT_SHA` and `GITHUB_SHA`. A production build in CI (`CI` set) that finds no id, and was given no `buildId`, now warns once: before, the build passed and the open tabs never moved onto it. Pass the commit as `buildId` on another service, or `buildId: ""` to keep the watch off without the warning.

## 0.2.2

### Patch Changes

- 2236f57: A reload that does not happen no longer leaves the tab stuck. When the user stayed at the page's unsaved-work prompt, or the back/forward cache brought the page back, the tab took itself as reloading for the rest of its life: the notice's Reload did nothing, `followNewBuild` never reloaded again, `isReloadingOntoNewBuild()` stayed true so errors went unreported, and an error screen behind `useChunkErrorRecovery` stayed blank. Now the first key or pointer press after a reload started, or the restore from the back/forward cache, ends it: the tab can reload again, errors are reported again, and the error screen shows its error. `subscribeToReload(listener)` tells an error screen of your own when that happens.

## 0.2.1

### Patch Changes

- b03e569: `client` in `build.json` now covers each browser file's name and exact content, so it changes whenever a file a tab could load is renamed or changed. Before, it took file names and the build's id out, as the module fingerprints do: in an app that writes its commit into its browser code, a server-only commit renamed chunks but kept `client`, so a tab on the old build skipped the whole-page load at its next move and could hit a chunk the new deploy no longer served. Module fingerprints still ignore file names and the id, so the notice stays as it was. A `buildId` shorter than seven characters (a CI build number) is no longer taken out of module fingerprints, where it hid changes to any run of characters containing it.

## 0.2.0

### Minor Changes

- fd0015b: Tell deploys apart by what they change in the browser. `build.json` now fingerprints the browser code (`client`), so once a tab has read its own build's file, a deploy that left that code as it was (a server-only commit) is not new: no notice, and no reload at the next move. With the plugin's new `modules` option, it also fingerprints each named module (the code its lazily loaded files bring beyond the page that loads them), and `useNewBuildNotice({ module })` shows only once a deploy changed the module on screen (`isModuleChanged`, `learnPageBuild`). A fingerprint ignores file names and the build's id, so a change in one module leaves the others' alone, though Rollup renames most chunks.
  
  Breaking: `parseBuildFile` returns a `BuildFile` (`{ id, client?, modules? }`) instead of the id, and `createDeployWatch`'s `fetchLive` resolves to one. Once a newer build is live, `check()` keeps reading `build.json` (spaced as before) instead of stopping, so a later deploy can change another module.

## 0.1.1

### Patch Changes

- 494786f: Document every export, one table per entry point, and two details of the check: it also runs when the browser comes back online, and it reads `build.json` without cookies, so that file has to be served to visitors who are not signed in.
