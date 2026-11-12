---
"@rivi-software/posthog-tanstack-start": patch
---

Secret paths now redact routes written with a splat (`/files/$`, `{$}`), braces (`{$token}`, `{-$token}`, fixed text around them such as `prefix{$id}` or `{$token}.pdf`) or a trailing slash (`/t/$token/`). These used to reach PostHog as the link itself. `setSecretPaths` and `redactSecretPaths` now throw for a pattern TanStack Router would read differently, such as `prefix$id`, instead of never matching it. The README lists the syntax they read.
