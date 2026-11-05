---
"@rivi-software/deploy-watch": minor
---

The Vite plugin now also reads the build's id from `CF_PAGES_COMMIT_SHA` (Cloudflare Pages) and `CI_COMMIT_SHA` (GitLab CI, and the services that use its name), after `WORKERS_CI_COMMIT_SHA` and `GITHUB_SHA`. A production build in CI (`CI` set) that finds no id, and was given no `buildId`, now warns once: before, the build passed and the open tabs never moved onto it. Pass the commit as `buildId` on another service, or `buildId: ""` to keep the watch off without the warning.
