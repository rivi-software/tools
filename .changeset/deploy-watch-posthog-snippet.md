---
"@rivi-software/deploy-watch": patch
---

A module's fingerprint in `build.json` now reads the snippet that PostHog's source map plugin (`@posthog/rollup-plugin`) writes into every chunk without the release's id and the chunk's id, and leaves out its `//# chunkId=` comment. `useNewBuildNotice({ module })` then shows only once a deploy changed that module's code. Before, with `posthogSourcemaps` from `@rivi-software/posthog-tanstack-start` in the build, every deploy changed every module's fingerprint, so every module's notice showed after every deploy, a server-only commit included. The `client` fingerprint still changes with every deploy that uploads source maps, since the plugin renames every chunk; the README's "With PostHog's source map upload" says what that means for an app.
