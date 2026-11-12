---
"@rivi-software/posthog-tanstack-start": patch
---

The Worker now sends an exception with its secret paths (`setSecretPaths`) as their pattern in the error's message and stack and in the properties sent with it, not only in `$current_url` and `$pathname`. Before, an error such as ``new Error(`ticket ${request.url} not found`)`` sent the link to PostHog.
