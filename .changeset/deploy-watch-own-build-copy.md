---
"@rivi-software/deploy-watch": minor
---

A tab now learns its own build's fingerprints even when a deploy lands before it reads `build.json`. Before, it learned them only from a `build.json` that still named its build, and its first check waited at least a minute after the page loaded. A tab that missed that read took every other build as new and every module as changed: a tab opened shortly before a server-only deploy loaded the whole page at its next move for nothing, and a notice for a module showed for a deploy that did not touch that module.

The Vite plugin now also writes a copy of `build.json` under the build's own name in the assets directory, `assets/deploy-watch-<id>.json`. When a check finds another build in `build.json` and the tab has no file of its own yet, it reads that copy once. A host that keeps a replaced build's assets serves it after the deploy; `@rivi-software/cloudflare-deploy`'s skew protection keeps it for seven days. The browser builds the name from the page's id, so the browser code stays the same across commits, and the copy is in no fingerprint. An id that is not a plain file name gets no copy.

`startDeployWatch()` also reads `build.json` once soon after the page loads, when the browser is idle, which costs one static-asset request per page load. This helps on hosts that keep no replaced files. `useNewBuildNotice({ module })` no longer calls `learnPageBuild()` itself, since the watch now does that read.
