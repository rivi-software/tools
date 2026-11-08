# @rivi-software/posthog-tanstack-start

## 0.1.2

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.1.1

### Patch Changes

- 440e806: Document the versions of TanStack Start, Vite and the PostHog SDKs the package needs, `captureServerEvent`'s arguments, that a failed send only logs a warning, and that a build without `POSTHOG_PERSONAL_API_KEY` uploads no source maps.
