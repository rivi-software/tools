---
"@rivi-software/posthog-tanstack-start": patch
---

The Worker's secret paths (`setSecretPaths`) now leave as their pattern in a `captureServerEvent` event's properties too, as they do in an exception's. An app that sets no secret paths sends its events as before. On both sides, a property that holds itself now leaves redacted, with `"[Circular]"` where it holds itself, as posthog-node writes it; before, the redaction overflowed the stack on it.
