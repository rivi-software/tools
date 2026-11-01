# @rivi-software/deploy-watch

## 0.2.0

### Minor Changes

- fd0015b: Tell deploys apart by what they change in the browser. `build.json` now fingerprints the browser code (`client`), so once a tab has read its own build's file, a deploy that left that code as it was (a server-only commit) is not new: no notice, and no reload at the next move. With the plugin's new `modules` option, it also fingerprints each named module (the code its lazily loaded files bring beyond the page that loads them), and `useNewBuildNotice({ module })` shows only once a deploy changed the module on screen (`isModuleChanged`, `learnPageBuild`). A fingerprint ignores file names and the build's id, so a change in one module leaves the others' alone, though Rollup renames most chunks.
  
  Breaking: `parseBuildFile` returns a `BuildFile` (`{ id, client?, modules? }`) instead of the id, and `createDeployWatch`'s `fetchLive` resolves to one. Once a newer build is live, `check()` keeps reading `build.json` (spaced as before) instead of stopping, so a later deploy can change another module.

## 0.1.1

### Patch Changes

- 494786f: Document every export, one table per entry point, and two details of the check: it also runs when the browser comes back online, and it reads `build.json` without cookies, so that file has to be served to visitors who are not signed in.
