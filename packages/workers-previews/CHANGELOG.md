# @rivi-software/workers-previews

## 0.1.2

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.
- Updated dependencies [5fcdab0]
  - @rivi-software/cloudflare-deploy@0.3.1

## 0.1.1

### Patch Changes

- 4b3cc5c: Add doc comments to the `PreviewNameOptions`, `SweepOptions`, `SweepResult`, `GitHubRepositoryOptions` and `DeployPreviewOptions` types, and to `SweepResult`'s `entries` and `targets` and `DeployPreviewOptions`' `branch`, so an editor shows them. This is the first version the release workflow publishes, with npm provenance; 0.1.0 was published by hand.
