# @rivi-software/workers-bundle-check

## 0.2.0

### Minor Changes

- a48e2de: The secret check finds Cloudflare's own credentials in their prefixed formats: a Global API key (`cfk_`), a user or account API token (`cfut_`, `cfat_`) and an Access service token secret (`cfast_`). A `CLOUDFLARE_API_TOKEN` that a `define` or an `import.meta.env` read inlines into the build now fails the check. Credentials in the older format, without a prefix, still have no shape to find.

### Patch Changes

- 12d6145: The check now follows symbolic links as Wrangler does. Before, it passed over every link in the assets directory, though Wrangler serves a link to a file as that file, so a linked `.map` file or `.env` was served unreported. A link to a file in the assets now counts as the file, a link to a directory serves the files in it, and a report names each by its path in the assets directory. In `serverDir`, a link to a file is read too, and a link to a directory is not followed, on every Node version.

## 0.1.3

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.1.2

### Patch Changes

- cedacc0: Depend on `minimatch` 11 instead of 10. Globs match the same files as before.

## 0.1.1

### Patch Changes

- e1eda68: Add doc comments to the fields of each `WorkerBundleProblem` kind, to `WorkerBundleReport`'s `problems`, to `SecretPattern`'s `name` and `pattern`, and to `BundledModule`'s `path` and `bytes`, so an editor shows them. This is the first version the release workflow publishes, with npm provenance; 0.1.0 was published by hand.
