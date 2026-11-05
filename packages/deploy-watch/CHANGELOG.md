# @rivi-software/deploy-watch

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
