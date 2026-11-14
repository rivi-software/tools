# @rivi-software/posthog-tanstack-start

## 1.0.0

### Major Changes

- e686453: The package is now at 1.0.0, and its releases follow semantic versioning: a breaking change raises the major version. Nothing in the package changes in this release. Before, its 0.x versions could break in a minor release. A range such as `^0.4.0` does not pick up 1.0.0, so change it to `^1.0.0` to get this and later releases.

## 0.1.5

### Patch Changes

- b90ba69: When posthog-js does not load in the browser, such as on a dropped connection or in a tab that outlived the deploy that removed its chunk, `initPostHog` now logs one warning and PostHog stays off: `withPostHog` and `captureClientException` do nothing, and the next call to `initPostHog` imports posthog-js again. When posthog-js throws as it starts, `initPostHog` logs one warning too, and PostHog stays off for the page. Before, either failure was an unhandled rejection, each later `withPostHog` or `captureClientException` call added another one that reached the app's `unhandledrejection` handlers, and `initPostHog` never tried again, so the page reported nothing for the rest of the session.

## 0.1.4

### Patch Changes

- 342c1e6: Secret paths now redact routes written with a splat (`/files/$`, `{$}`), braces (`{$token}`, `{-$token}`, fixed text around them such as `prefix{$id}` or `{$token}.pdf`) or a trailing slash (`/t/$token/`). These used to reach PostHog as the link itself. `setSecretPaths` and `redactSecretPaths` now throw for a pattern TanStack Router would read differently, such as `prefix$id`, instead of never matching it. The README lists the syntax they read.
  
  Check your patterns against that list before you upgrade. A pattern the router reads differently now throws when the Worker or the page starts, including one that used to redact something: `/files/$/edit` redacted one segment, but the router reads its `$` as the rest of the path. Write it as `/files/$`, or as `/files/{$}/edit` for an address that ends in `/edit`.

## 0.1.3

### Patch Changes

- 212bfb0: The Worker's secret paths (`setSecretPaths`) now leave as their pattern in a `captureServerEvent` event's properties too, as they do in an exception's. An app that sets no secret paths sends its events as before. On both sides, a property that holds itself now leaves redacted, with `"[Circular]"` where it holds itself, as posthog-node writes it; before, the redaction overflowed the stack on it.
- 017dee0: The Worker now sends an exception with its secret paths (`setSecretPaths`) as their pattern in the error's message and stack and in the properties sent with it, not only in `$current_url` and `$pathname`. Before, an error such as ``new Error(`ticket ${request.url} not found`)`` sent the link to PostHog.

## 0.1.2

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.1.1

### Patch Changes

- 440e806: Document the versions of TanStack Start, Vite and the PostHog SDKs the package needs, `captureServerEvent`'s arguments, that a failed send only logs a warning, and that a build without `POSTHOG_PERSONAL_API_KEY` uploads no source maps.
