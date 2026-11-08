---
"@rivi-software/cloudflare-deploy": patch
"@rivi-software/d1-migrations": patch
"@rivi-software/deploy-watch": patch
"@rivi-software/posthog-tanstack-start": patch
"@rivi-software/semgrep-github-report": patch
"@rivi-software/vite-plugin-zod-jitless": patch
"@rivi-software/workers-bundle-check": patch
"@rivi-software/workers-coordination": patch
"@rivi-software/workers-mail": patch
"@rivi-software/workers-previews": patch
---

The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.
