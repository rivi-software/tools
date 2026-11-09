---
"@rivi-software/cloudflare-deploy": minor
---

`runCommand` and `runOrThrow` take `retry: { attempts, delayMs }`, like the API client. A command that exits non-zero runs again when its output shows a transient Cloudflare failure: a 5xx status, error code 10500, a malformed API response or a network error. Any other failure ends it at once. Retries are off by default; turn them on for commands that are safe to repeat, such as `wrangler r2 object get`, or `wrangler deploy` of the same build.
