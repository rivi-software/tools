---
"@rivi-software/posthog-tanstack-start": patch
---

When posthog-js does not load in the browser, such as on a dropped connection or in a tab that outlived the deploy that removed its chunk, `initPostHog` now logs one warning and PostHog stays off: `withPostHog` and `captureClientException` do nothing, and the next call to `initPostHog` imports posthog-js again. When posthog-js throws as it starts, `initPostHog` logs one warning too, and PostHog stays off for the page. Before, either failure was an unhandled rejection, each later `withPostHog` or `captureClientException` call added another one that reached the app's `unhandledrejection` handlers, and `initPostHog` never tried again, so the page reported nothing for the rest of the session.
