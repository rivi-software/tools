# @rivi-software/cloudflare-deploy

## 0.2.0

### Minor Changes

- a016496: Add `/testing`, test doubles for code that works with Cloudflare. `createFakeCloudflareApi()` keeps D1 databases, KV namespaces, R2 buckets and Workers for Platforms scripts in memory, and serves every endpoint `cloudflareApi` calls with Cloudflare's statuses and error codes: names taken, missing resources, R2 jurisdictions, Durable Object migration tags, and secrets an upload drops without `keep_bindings`. It logs each call, counts creates, and fails a call on request (`failNext`), also after carrying it out, so a test can show that a retry creates nothing twice. `memoryKv()` is a KV namespace in memory that models Cloudflare's cache: a location keeps what it read for `cacheTtl` seconds, so a write shows elsewhere only once that copy runs out. It holds KV's limits, with errors worded like the runtime's.

## 0.1.1

### Patch Changes

- 653205c: Export the `CloudflareError` and `D1Export` types from the main entry point too, and document every export: doc comments for editors, and in the README the API client's options, the health check's timeout and redirects, the limits of skew protection, and a table of each entry point's exports.
