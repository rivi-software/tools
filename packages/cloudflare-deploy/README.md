# @rivi-software/cloudflare-deploy

[![npm version](https://img.shields.io/npm/v/@rivi-software/cloudflare-deploy?label=npm&color=0b6b3a)](https://www.npmjs.com/package/@rivi-software/cloudflare-deploy) [![CI status](https://img.shields.io/github/actions/workflow/status/rivi-software/tools/ci.yml?branch=main&label=CI)](https://github.com/rivi-software/tools/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-0b6b3a)](LICENSE)

Deploy helpers for apps on Cloudflare Workers:
- guards for a deploy script's environment, and for placeholder binding ids in its config
- a secrets file for `wrangler deploy --secrets-file`, written from the environment and deleted after the deploy
- a health check for a fresh deployment
- child-process helpers
- a small client for the Cloudflare REST API, covering the resources an app creates at runtime (D1, KV, R2, Workers for Platforms)
- skew protection, which keeps earlier builds' client files served after a deploy, so a tab still running the previous build can load its lazy chunks
- test doubles: a fake of that REST API, and a KV namespace whose reads go stale as they do on Cloudflare

## Install

```bash
npm install @rivi-software/cloudflare-deploy
```

The package is ESM only. The deploy helpers need Node 22 or later. `/cloudflare-api`, `/previous-assets` and `/testing` use only web APIs, so they run in a Worker as well.

## Entry points

| Entry point | Contents | Runs in |
| --- | --- | --- |
| `@rivi-software/cloudflare-deploy` | Everything below except `/testing` | Node (deploy scripts) |
| `@rivi-software/cloudflare-deploy/cloudflare-api` | The API client alone | Node and Workers |
| `@rivi-software/cloudflare-deploy/previous-assets` | The Worker half of [skew protection](#skew-protection) | Workers |
| `@rivi-software/cloudflare-deploy/testing` | The [test doubles](#testing) | Node and Workers (tests) |
| `cloudflare-retain-assets` (bin) | The deploy half of skew protection | Node |

In Worker code, import from the subpaths: the main entry also pulls in `node:child_process` and `node:fs` through the process helpers.

## Deploy scripts

- **Environment guards.**
  - `requireEnv(name)` and `requireEnvMinLength(name, min)`.
  - `requireCloudflareAccountId(env, name = "CLOUDFLARE_ACCOUNT_ID")`: 32 lowercase hexadecimal characters, the form Cloudflare's account IDs take.
  - `assertProductionBuildBranch(env, branch = "main")` refuses a production deploy on GitHub Actions unless it is a push or a manual run on `branch`, and on Cloudflare Workers Builds unless `WORKERS_CI_BRANCH` is `branch`. Elsewhere, such as a deploy from your own machine, it passes.

  Each guard takes an optional `env` record (default `process.env`).
- **Binding ids.** `await assertDeployedBindings(config, options?)` refuses a config whose D1 or KV bindings still carry a placeholder id, such as the `<PREVIEW_DATABASE_ID>` in Cloudflare's Preview examples, a `TODO` or an all-zero id. Wrangler finds such an id only at the upload, or at the first request that uses the binding, by which time a deploy script may have applied migrations. One error lists every such binding:

  ```text
  dist/server/wrangler.json has placeholder binding ids:
    d1_databases[DB].database_id = "<PREVIEW_DATABASE_ID>"
    kv_namespaces[CACHE].id = "TODO"
  ```

  - A D1 `database_id` must be a UUID, and a KV `id` 32 hexadecimal characters. Neither may be all zeros.
  - A binding without an id passes, because Wrangler creates the resource on deploy.
  - `config` is the path to a JSON or JSONC config, such as the `wrangler.json` the Cloudflare Vite plugin writes, or a config you have parsed. Parse a TOML config yourself.
  - It checks the top level, which `wrangler deploy` deploys. `environment: "staging"` checks `env.staging` instead, and `previews: true` checks the `previews` block, which `wrangler preview` deploys. Wrangler does not inherit bindings into either, so each block's own lists are what deploys.
- **Secrets file.** `withSecretsFile({ prefix }, run)` writes the secrets in the environment to a file for `wrangler deploy --secrets-file` or `wrangler secret bulk`, and runs `run` with its path.
  - Each variable `<PREFIX>_<NAME>` becomes the secret `<NAME>`: with the prefix `WORKER_SECRET`, `WORKER_SECRET_API_KEY` sets `API_KEY`. The Worker keeps the secrets the file leaves out.
  - An empty variable is an error, raised before anything is written. On GitHub Actions a secret that does not exist reads as empty, and uploading it would blank the Worker's secret. Leave a variable out to keep the Worker's current value.
  - The file is JSON, in a new directory under the system's temporary directory, and only you can read it (`0600`). It is deleted once `run` settles, also when `run` throws. A process killed outright skips that, and leaves the file where still only you can read it.
  - It returns what `run` returns.
  - With `listSecrets`, the arguments that select the Worker for `wrangler secret list` (`["--config", config]` or `["--name", worker]`), it warns after `run` about each secret on the Worker that no variable sets, such as one left over from an earlier release. When it cannot read the list, that is a warning too, not a failure.
  - `secretsFromEnv(prefix, env?)` returns the same secrets without writing them. Call it at the start of the script to refuse an empty variable before anything changes.
- **Health check.** `checkDeploymentHealth(origin, options)` polls a fresh deployment until one of `paths` answers `2xx`.
  - It retries network errors and the statuses a deployment answers while it propagates (404, 429, 500, 502, 503, 504).
  - Any other status fails at once, because then the deployment is wrong rather than late.
  - The default window (16 attempts, 4 s apart) outlasts a custom domain's rollout, during which the previous version keeps answering for tens of seconds after `wrangler deploy`. `attempts`, `delayMs` and `timeoutMs` (30 s a request) change it.
  - It follows no redirect: a redirect fails the attempt like a network error, so pass the origin that answers, not one that redirects to it.
  - `validate` checks the body of the response that passed. A `validate` that throws fails the check at once.
- **Process helpers.**
  - `runCommand` treats a non-zero exit as a result; `runOrThrow` throws on one.
  - `wranglerCommand` runs your project's own Wrangler, found through `binPath`.
  - `cloudflareApiToken` reads `CLOUDFLARE_API_TOKEN`, else asks `wrangler login` for its token.
  - `nodeScript` runs a TypeScript entry through `tsx`, which your project then needs.
  - `sleep` and `fileExists`.

```ts
import {
  assertDeployedBindings,
  assertProductionBuildBranch,
  checkDeploymentHealth,
  requireCloudflareAccountId,
  requireEnv,
  runOrThrow,
  withSecretsFile,
  wranglerCommand,
} from "@rivi-software/cloudflare-deploy";

const config = "dist/server/wrangler.json";
assertProductionBuildBranch();
const accountId = requireCloudflareAccountId();
requireEnv("CLOUDFLARE_API_TOKEN");
await assertDeployedBindings(config);
await withSecretsFile({ prefix: "WORKER_SECRET" }, (path) =>
  runOrThrow(wranglerCommand(["deploy", "--config", config, "--secrets-file", path]), {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  }),
);
await checkDeploymentHealth("https://app.example.com", { paths: ["/healthz", "/"] });
```

## Cloudflare API client

`cloudflareApi({ accountId, token })` returns:
- `d1`: find, create, read replication, export, delete
- `kv`: namespaces and their keys (`listKeys`, `getText`, bulk `putMany` and `deleteMany`)
- `r2`: buckets with their jurisdiction, lifecycle and lock rules
- `dispatch`: Workers for Platforms namespace scripts (get, upload, list by tag, secrets, tags, delete)
- `call` and `maybe`, for any other endpoint under the account

It uses only `fetch`, `FormData` and `Blob`.

- **Other endpoints.** `call(method, path, init)` sends a request to `path` under `/accounts/<accountId>` and answers the envelope's `result`. `init` takes a `json` or `form` body, `query`, `headers`, and `idempotent` for a POST that is safe to send twice. `maybe` answers `undefined` for a 404 instead of throwing.
- **Timeouts.** Each request gives up after `timeoutMs` (30 s by default).
- **Errors.** A failure throws `CloudflareApiError` with the method, the path, the status and Cloudflare's error codes (`error.has(10008)`), never the token. A lookup returns `undefined` for a missing resource, so missing and failed stay apart.
- **Retries.** With `retry: { attempts }`, the client sends a request again while Cloudflare answers 429 or 5xx or the request fails on the way. It pauses 1 s, then twice as long each time. This applies only to requests that are safe to repeat: reads, replacing writes, deletes and KV bulk deletes. A create is sent once. Retries are off by default, so Worker code keeps its own policy.

```ts
import { cloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";

const api = cloudflareApi({ accountId, token });
const database =
  (await api.d1.find("customer-db")) ??
  (await api.d1.create({ name: "customer-db", jurisdiction: "eu" }));
```

## Skew protection

A Worker version serves only its own build's static files, and Cloudflare keeps no older ones; version affinity covers gradual deployments only. A tab opened before a deploy keeps running the previous build, and every chunk it loads lazily after the deploy is a 404.

This package keeps every build's hashed `/assets/*` files in a KV namespace of the app's own, bound as `PREVIOUS_ASSETS`. Each file stays for `RETAIN_DAYS` (7) after the deploy that replaced it. [`@rivi-software/deploy-watch`](https://github.com/rivi-software/tools/tree/main/packages/deploy-watch#readme) moves such tabs onto the new build at a safe moment; this package keeps them working until then.

### Before each deploy

`cloudflare-retain-assets --config <wrangler.json>` reads the config Wrangler is about to deploy, such as the `wrangler.json` the Cloudflare Vite plugin writes beside the Worker's build. The config needs `assets.directory` and the `PREVIOUS_ASSETS` namespace bound by id. The command:
1. uploads the build's files under `assets/` that the store lacks, never source maps, base64 in bulk with their content type as metadata
2. deletes the files no tab needs any more
3. writes the store's `record` last

The record lists every stored file with the time the first deploy without it went live (`null` while it is live). A file the record does not know counts from the current deploy, so a lost record or a run that stopped halfway removes nothing early, and a rerun changes nothing.

The account comes from the config's `account_id`, else `CLOUDFLARE_ACCOUNT_ID`. The token comes from `CLOUDFLARE_API_TOKEN`, else `wrangler login`, and needs **Workers KV Storage: Edit**. Each request is sent up to five times, over about 15 s, while Cloudflare answers a passing `internal error`. The build is labelled with `GITHUB_SHA`, else `WORKERS_CI_COMMIT_SHA`, else `local`. It prints one line: how many files the build has, how many were new, how many it kept from earlier builds and how many it removed.

From code, call `retainBuildAssets({ api, namespaceId, clientDir, build })`; `planRetention` is the pure decision behind it.

```bash
vite build
cloudflare-retain-assets --config dist/server/wrangler.json
wrangler deploy --config dist/server/wrangler.json
```

### In the Worker

Workers Assets serves the live build's files before the Worker runs, as long as `run_worker_first` leaves `/assets/*` out. So a request under `/assets/` that reaches the Worker asks for a file the live build lacks.

`isAssetRequest` picks those requests (`GET` and `HEAD`). `servePreviousAsset(request, env.PREVIOUS_ASSETS)` answers from the store, cached as immutable for a year, or with a `404` that nothing caches. Without the binding (local development, previews) every such request is a `404`.

```jsonc
// wrangler.jsonc
{
  "assets": { "directory": "./dist/client" },
  "kv_namespaces": [{ "binding": "PREVIOUS_ASSETS", "id": "<namespace id>" }],
}
```

```ts
import { isAssetRequest, servePreviousAsset } from "@rivi-software/cloudflare-deploy/previous-assets";

export default {
  async fetch(request, env) {
    if (isAssetRequest(request)) return servePreviousAsset(request, env.PREVIOUS_ASSETS);
    return app.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
```

The first deploy after the store exists keeps only its own build, so it cannot protect tabs on the build before it. To inspect a store, run `wrangler kv key get record --namespace-id <id> --remote`.

## Testing

`/testing` holds two test doubles for code that works with Cloudflare. Neither of them calls Cloudflare.

### A fake of the REST API

`createFakeCloudflareApi(options?)` keeps D1 databases, KV namespaces, R2 buckets and Workers for Platforms scripts in memory. It serves every endpoint the [client](#cloudflare-api-client) calls, with Cloudflare's envelopes, statuses and error codes. Give the client the fake's `fetch`, or pass the whole fake as the client's options: it carries `accountId`, `token` and `fetch`.

```ts
import { cloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import { createFakeCloudflareApi } from "@rivi-software/cloudflare-deploy/testing";

const fake = createFakeCloudflareApi();
const api = cloudflareApi({ accountId: fake.accountId, token: "test", fetch: fake.fetch });
await provisionCustomer(api, "acme");
expect(fake.state.d1.databases.map((db) => db.name)).toContain("customer-acme");
```

- **State.** `fake.state` holds what exists in plain arrays: `d1.databases`, `kv.namespaces`, `r2.buckets` and `dispatch.scripts`. A test reads them, or changes them to set up a case. For example, `bucket.objects = 3` gives a bucket that cannot be deleted, and `database.sql` is what an export of the database serves.
- **Calls.** `fake.calls` logs each call as its method and its path under the account, as sent: `"POST /d1/database"`. `fake.creates` counts the D1 databases, KV namespaces, R2 buckets and dispatch scripts made.
- **Failures.** `fake.failNext(method, pattern, failure?)` fails the next call whose path matches `pattern`. By default the call answers 500 with code 10000; `status`, `code` and `message` change that. `network` makes the request fail on the way instead. `apply` carries the call out first, as when Cloudflare acted but its answer was lost. `skip` lets that many matching calls through first, and `times` fails that many. `clearFailures()` drops the failures that have not happened yet. With these, a test can show that a retry after any failure creates nothing twice.
- **Exports.** A D1 export finishes on the second poll. Its `signedUrl` points at a `.test` host that only the fake's `fetch` serves.
- **Other hosts.** The fake's `fetch` throws for any origin but the API's, so code under test can't reach the network through it.
- **Options.** `accountId` (32 `f`s by default), `token` (by default any bearer token passes) and `now`, the clock for creation times.

The fake answers these requests as Cloudflare does:

| Request | Answer |
| --- | --- |
| For another account | 403, code 9109 |
| With a token other than `token`, when you set one | 403, code 10000 |
| To a path the fake does not serve | 400, code 7000 |
| With a body that is not JSON | 400, code 6007 |
| D1: a database that does not exist | 404, code 7404 |
| D1: a create without a name, or an unknown read replication mode | 400, code 7400 |
| D1: a create with a name that is taken | 400, code 7502 |
| KV: a namespace that does not exist | 404, code 10013 |
| KV: a create with a title that is taken | 400, code 10014 |
| KV: a value that does not exist | 404, code 10009 |
| R2: a create with an invalid bucket name | 400, code 10005 |
| R2: a bucket that does not exist, or one asked for outside its jurisdiction | 404, code 10006 |
| R2: a create with a name taken in that jurisdiction | 409, code 10073 |
| R2: deleting a bucket that holds objects | 409, code 10008 |
| Dispatch: reading a script that does not exist | 200 with `script: null` |
| Dispatch: deleting, or setting secrets or tags on, a script that does not exist | 404, code 10007 |
| Dispatch: an upload without its `main_module`, with a D1 binding that has no id, or with a migration step that does not fit the script's classes | 400, code 10021 |
| Dispatch: a migration whose `old_tag` is not the script's current tag | 400, code 10079 |
| Dispatch: a Durable Object binding to a class the script does not have | 400, code 10061 |

An upload also drops the script's secrets unless its `keep_bindings` includes `secret_text`.

Some codes are a best guess, because Cloudflare's documentation names none: 9109, 6007, 10061, 10021 for the migration checks, and the codes for malformed KV and R2 bodies the client never sends. A test that depends on one of these should check the status as well.

### A KV namespace that serves stale reads

`memoryKv(options?)` is a KV namespace in memory. Unlike a local KV, it also models Cloudflare's cache. Each location keeps what it read, the value or its absence, for `cacheTtl` seconds (60 by default). A write is visible at once in the location that made it, and elsewhere only once that location's copy runs out. `location()` gives another location over the same keys, so a test can write in one and read the old value in the other.

```ts
import { memoryKv } from "@rivi-software/cloudflare-deploy/testing";

vi.useFakeTimers();
const kv = memoryKv();
const elsewhere = kv.location();
await elsewhere.get("flag"); // null, and that location keeps the null for 60 s
await kv.put("flag", "on");
await kv.get("flag"); // "on"
await elsewhere.get("flag"); // still null
vi.advanceTimersByTime(60_000);
await elsewhere.get("flag"); // "on"

const env = { FLAGS: kv as unknown as KVNamespace };
```

- **The binding's methods.** `get` and `getWithMetadata` (one key, or a map for up to 100), `put`, `delete` and `list` behave as on the binding, and `cacheStatus` is always `null`. Its types do not come from `@cloudflare/workers-types`, so cast it where code wants a `KVNamespace`. `list` reads the keys as they are now, without a cache.
- **Limits.** Errors are worded like the runtime's. It refuses:
  - keys of 0 or over 512 bytes, and the keys `.` and `..`
  - values over 25 MiB, and metadata over 1024 bytes as JSON
  - a `cacheTtl` under 30 seconds
  - an `expiration` or `expirationTtl` under 60 seconds from now
  - a bulk read of over 100 keys, or of types other than text and JSON
  - a `list` page of over 1000 keys

  `list` returns keys in UTF-8 byte order, as KV does, with a `cursor` for the next page.
- **Inspecting.** `operations` counts each location's `get`, `put`, `delete` and `list` calls, and its `coldReads`, the reads its cache did not answer. `dump()` returns the live keys with their values as text.
- **Failures.** `failPuts(count)` makes the next `count` puts, in any location, throw the 429 KV answers when one key is written too often.
- **Clock.** `now`, in milliseconds, defaults to `Date.now`, so fake timers move it.

## Limits

- **`/assets/` at the root.** Skew protection covers the files Vite writes under its default `build.assetsDir` (`assets`) and serves at `/assets/…`, under the default `base`. With another `assetsDir`, the command finds no `assets/` directory and fails (`No build files in …`); under another `base`, the Worker's requests for old files are not under `/assets/`, so `isAssetRequest` passes them by.
- **One store per app.** A deploy treats every stored file its build lacks as replaced, so two apps that share a namespace remove each other's files early.
- **File size.** KV takes a value of at most 25 MiB, so a larger build file fails the upload, and with it the command.

## Exports

From `@rivi-software/cloudflare-deploy` (Node):

| Export | What |
| --- | --- |
| `requireEnv(name, env?)`, `requireEnvMinLength(name, min, env?)`, `requireCloudflareAccountId(env?, name?)` | A variable's value, or an error that names it |
| `assertProductionBuildBranch(env?, branch?)` | Refuses a production deploy from another branch in CI |
| `assertDeployedBindings(config, options?)` | Refuses placeholder D1 and KV ids in a Wrangler config; options `environment` and `previews` |
| `withSecretsFile(options, run)`, `secretsFromEnv(prefix, env?)` | The `<PREFIX>_*` secrets in a file only you can read, deleted after `run`; options `prefix`, `env` and `listSecrets` |
| `checkDeploymentHealth(origin, options?)` | Polls a fresh deployment until it answers; options `paths`, `validate`, `attempts`, `delayMs`, `timeoutMs` |
| `runCommand(args, options?)`, `runOrThrow(args, options?)` | Run a command; options `cwd`, `env`, `input` (written to stdin) and `capture` (collect the output) |
| `binPath(name, from?)`, `wranglerCommand(args, from?)`, `nodeScript(script, args?)` | The arguments that run a project's binary, its Wrangler, or a TypeScript file through `tsx` |
| `cloudflareApiToken(env?)` | `CLOUDFLARE_API_TOKEN`, else the token `wrangler login` holds |
| `sleep(ms)`, `fileExists(path)` | A pause; whether a regular file exists |
| `RETAIN_DAYS`, `retainBuildAssets(input)`, `planRetention(input)`, `readBuildFiles(clientDir)`, `previousAssetsTarget(config, configPath, env?)` | The deploy half of [skew protection](#skew-protection) |
| Everything from `/cloudflare-api`, and from `/previous-assets` all but `assetKey` | |
| Types | `Env`, `BindingsConfig`, `DeployedBindingsOptions`, `SecretsFileOptions`, `HealthCheckOptions`, `RunOptions`, `RunResult`, `AssetDeployConfig`, `AssetRecord`, `RetentionPlan` |

From `@rivi-software/cloudflare-deploy/cloudflare-api` (Node and Workers):

| Export | What |
| --- | --- |
| `cloudflareApi({ accountId, token, fetch?, timeoutMs?, retry? })` | The [client](#cloudflare-api-client) |
| `CloudflareApiError` | A failed call: `method`, `path`, `status`, `errors`, and `has(code)` |
| `CLOUDFLARE_API` | `https://api.cloudflare.com/client/v4` |
| Types | `CloudflareApi`, `CloudflareApiOptions`, `CloudflareError`, `D1DatabaseInfo`, `D1Export`, `Jurisdiction`, `LocationHint`, `KvNamespaceInfo`, `KvEntry`, `R2BucketInfo`, `R2LifecycleRule`, `R2LockRule`, `NamespaceScript`, `NamespaceScriptSummary`, `WorkerUpload`, `WorkerMetadata`, `WorkerModule`, `WorkerBinding`, `DurableObjectMigrationStep` |

From `@rivi-software/cloudflare-deploy/previous-assets` (Workers):

| Export | What |
| --- | --- |
| `isAssetRequest(request)` | Whether a request is a `GET` or `HEAD` under `/assets/` |
| `servePreviousAsset(request, store)` | The stored file, or a `404` |
| `assetKey(pathname)` | A file's key in the store: its path without the leading slash |
| `PREVIOUS_ASSETS_BINDING`, `ASSET_PATH_PREFIX` | `PREVIOUS_ASSETS` and `/assets/` |
| Types | `PreviousAssetStore`, the part of a KV binding it reads; `PreviousAssetMetadata` |

From `@rivi-software/cloudflare-deploy/testing` (Node and Workers, in tests):

| Export | What |
| --- | --- |
| `createFakeCloudflareApi({ accountId?, token?, now? })` | The [fake of the REST API](#a-fake-of-the-rest-api): `accountId`, `token`, `fetch`, `state`, `calls`, `creates`, `failNext(method, pattern, failure?)`, `clearFailures()` |
| `memoryKv({ now? })` | A [KV namespace that serves stale reads](#a-kv-namespace-that-serves-stale-reads) |
| `MemoryKv` | Its class: the binding's methods, plus `location()`, `operations`, `dump()` and `failPuts(count)` |
| Types | `FakeCloudflareApi`, `FakeCloudflareApiOptions`, `FakeFailure`, `FakeD1Database`, `FakeKvNamespace`, `FakeKvValue`, `FakeR2Bucket`, `FakeScript`, `FakeScriptModule`, `MemoryKvOptions`, `KvValueType`, `KvReadOptions`, `KvPutOptions`, `KvListOptions`, `KvListKey`, `KvListResult`, `KvValueWithMetadata`, `KvOperations` |

## Development

The tests in `tests/` cover:
- the environment guards
- the binding id check, on config objects and on JSON and JSONC files
- the secrets file: what it holds, its mode, its removal, and the comparison with the Worker's secrets
- the health check
- the API client, against a fake `fetch`
- the retention plan, and the deploy against a fake store
- the Worker's fallback
- the fake of the REST API, through the real client
- the KV namespace's cache, limits and listing

None of them calls Cloudflare. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 RIVI Software.

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>Part of <a href="https://github.com/rivi-software/tools#readme">RIVI tools</a>, the packages <a href="https://rivi.software">RIVI Software</a> builds its own apps with.</sub>
</p>
