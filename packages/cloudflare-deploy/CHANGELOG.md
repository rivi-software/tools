# @rivi-software/cloudflare-deploy

## 1.0.0

### Major Changes

- e686453: The package is now at 1.0.0, and its releases follow semantic versioning: a breaking change raises the major version. Nothing in the package changes in this release. Before, its 0.x versions could break in a minor release. A range such as `^0.4.0` does not pick up 1.0.0, so change it to `^1.0.0` to get this and later releases.

## 0.4.0

### Minor Changes

- a67af4c: `runCommand` and `runOrThrow` take `retry: { attempts, delayMs }`, like the API client. A command that exits non-zero runs again when its output shows a transient Cloudflare failure: a 5xx status, error code 10500, a malformed API response or a network error. Any other failure ends it at once. Retries are off by default; turn them on for commands that are safe to repeat, such as `wrangler r2 object get`, or `wrangler deploy` of the same build.

## 0.3.1

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.3.0

### Minor Changes

- a91cda8: Add `assertDeployedBindings` and `withSecretsFile`. `assertDeployedBindings(config)` reads a Wrangler config, from a JSON or JSONC file or as an object, and throws one error that lists every D1 or KV binding whose id is a placeholder: a D1 `database_id` that is not a UUID, a KV `id` that is not 32 hexadecimal characters, or an all-zero id. A binding without an id passes, as Wrangler provisions it. `environment` and `previews` check the block that `wrangler deploy --env` or `wrangler preview` deploys. `withSecretsFile({ prefix }, run)` turns each `<PREFIX>_<NAME>` variable into the secret `<NAME>`, writes them to a JSON file only its owner can read, hands its path to `run` for `wrangler deploy --secrets-file`, and deletes it also when `run` throws. It refuses empty variables, which is how GitHub Actions passes a secret that does not exist. With `listSecrets` it warns about secrets on the Worker that no variable sets. `secretsFromEnv(prefix)` collects the same secrets without writing them, so a script can refuse an empty one before it applies migrations.

## 0.2.0

### Minor Changes

- a016496: Add `/testing`, test doubles for code that works with Cloudflare. `createFakeCloudflareApi()` keeps D1 databases, KV namespaces, R2 buckets and Workers for Platforms scripts in memory, and serves every endpoint `cloudflareApi` calls with Cloudflare's statuses and error codes: names taken, missing resources, R2 jurisdictions, Durable Object migration tags, and secrets an upload drops without `keep_bindings`. It logs each call, counts creates, and fails a call on request (`failNext`), also after carrying it out, so a test can show that a retry creates nothing twice. `memoryKv()` is a KV namespace in memory that models Cloudflare's cache: a location keeps what it read for `cacheTtl` seconds, so a write shows elsewhere only once that copy runs out. It holds KV's limits, with errors worded like the runtime's.

## 0.1.1

### Patch Changes

- 653205c: Export the `CloudflareError` and `D1Export` types from the main entry point too, and document every export: doc comments for editors, and in the README the API client's options, the health check's timeout and redirects, the limits of skew protection, and a table of each entry point's exports.
