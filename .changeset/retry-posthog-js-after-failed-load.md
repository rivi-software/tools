---
"@rivi-software/posthog-tanstack-start": patch
---

When posthog-js does not load in the browser, such as on a dropped connection or in a tab that outlived the deploy that removed its chunk, `initPostHog` now logs one warning and PostHog stays off: `withPostHog` and `captureClientException` do nothing, and the next call to `initPostHog` imports posthog-js again. Before, the failed import was an unhandled rejection, each later `withPostHog` or `captureClientException` call added another one that reached the app's `unhandledrejection` handlers, and `initPostHog` never tried again, so the page reported nothing for the rest of the session.
