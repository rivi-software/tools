---
"@rivi-software/workers-bundle-check": minor
---

The secret check finds Cloudflare's own credentials in their prefixed formats: a Global API key (`cfk_`), a user or account API token (`cfut_`, `cfat_`) and an Access service token secret (`cfast_`). A `CLOUDFLARE_API_TOKEN` that a `define` or an `import.meta.env` read inlines into the build now fails the check. Credentials in the older format, without a prefix, still have no shape to find.
