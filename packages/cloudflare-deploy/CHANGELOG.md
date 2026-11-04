# @rivi-software/cloudflare-deploy

## 0.3.0

### Minor Changes

- a91cda8: Add `assertDeployedBindings` and `withSecretsFile`. `assertDeployedBindings(config)` reads a Wrangler config, from a JSON or JSONC file or as an object, and throws one error that lists every D1 or KV binding whose id is a placeholder: a D1 `database_id` that is not a UUID, a KV `id` that is not 32 hexadecimal characters, or an all-zero id. A binding without an id passes, as Wrangler provisions it. `environment` and `previews` check the block that `wrangler deploy --env` or `wrangler preview` deploys. `withSecretsFile({ prefix }, run)` turns each `<PREFIX>_<NAME>` variable into the secret `<NAME>`, writes them to a JSON file only its owner can read, hands its path to `run` for `wrangler deploy --secrets-file`, and deletes it also when `run` throws. It refuses empty variables, which is how GitHub Actions passes a secret that does not exist. With `listSecrets` it warns about secrets on the Worker that no variable sets. `secretsFromEnv(prefix)` collects the same secrets without writing them, so a script can refuse an empty one before it applies migrations.

## 0.2.0

### Minor Changes

- a016496: Add `/testing`, test doubles for code that works with Cloudflare. `createFakeCloudflareApi()` keeps D1 databases, KV namespaces, R2 buckets and Workers for Platforms scripts in memory, and serves every endpoint `cloudflareApi` calls with Cloudflare's statuses and error codes: names taken, missing resources, R2 jurisdictions, Durable Object migration tags, and secrets an upload drops without `keep_bindings`. It logs each call, counts creates, and fails a call on request (`failNext`), also after carrying it out, so a test can show that a retry creates nothing twice. `memoryKv()` is a KV namespace in memory that models Cloudflare's cache: a location keeps what it read for `cacheTtl` seconds, so a write shows elsewhere only once that copy runs out. It holds KV's limits, with errors worded like the runtime's.

## 0.1.1

### Patch Changes

- 653205c: Export the `CloudflareError` and `D1Export` types from the main entry point too, and document every export: doc comments for editors, and in the README the API client's options, the health check's timeout and redirects, the limits of skew protection, and a table of each entry point's exports.
