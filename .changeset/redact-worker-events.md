---
"@rivi-software/posthog-tanstack-start": patch
---

The Worker's secret paths (`setSecretPaths`) now leave as their pattern in a `captureServerEvent` event's properties too, as they do in an exception's. An app that sets no secret paths sends its events as before.
