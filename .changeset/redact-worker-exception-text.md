---
"@rivi-software/posthog-tanstack-start": patch
---

The Worker now sends its secret paths (`setSecretPaths`) as their pattern everywhere in an event: an exception's message and stack, and the properties of every exception and `captureServerEvent` event, not only an exception's `$current_url` and `$pathname`. Before, an error such as ``new Error(`ticket ${request.url} not found`)`` sent the link to PostHog. An app that sets no secret paths sends its events as before.
