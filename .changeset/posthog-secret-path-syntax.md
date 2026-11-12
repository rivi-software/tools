---
"@rivi-software/posthog-tanstack-start": patch
---

Secret paths now redact routes written with a splat (`/files/$`, `{$}`), braces (`{$token}`, `{-$token}`, fixed text around them such as `prefix{$id}` or `{$token}.pdf`) or a trailing slash (`/t/$token/`). These used to reach PostHog as the link itself. `setSecretPaths` and `redactSecretPaths` now throw for a pattern TanStack Router would read differently, such as `prefix$id`, instead of never matching it. The README lists the syntax they read.

Check your patterns against that list before you upgrade. A pattern the router reads differently now throws when the Worker or the page starts, including one that used to redact something: `/files/$/edit` redacted one segment, but the router reads its `$` as the rest of the path. Write it as `/files/$`, or as `/files/{$}/edit` for an address that ends in `/edit`.
