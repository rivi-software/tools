# @rivi-software/cloudflare-deploy

Deploy helpers for apps on Cloudflare Workers:
- guards for a deploy script's environment
- a health check for a fresh deployment
- child-process helpers
- a small client for the Cloudflare REST API, covering the resources an app creates at runtime (D1, KV, R2, Workers for Platforms)
- skew protection, which keeps earlier builds' client files served after a deploy, so a tab still running the previous build can load its lazy chunks

```bash
npm install @rivi-software/cloudflare-deploy
```

The package is ESM only. The deploy helpers need Node 22 or later. `/cloudflare-api` and `/previous-assets` use only web APIs, so they run in a Worker as well.

## Entry points

| Entry point | Contents | Runs in |
| --- | --- | --- |
| `@rivi-software/cloudflare-deploy` | Everything below | Node (deploy scripts) |
| `@rivi-software/cloudflare-deploy/cloudflare-api` | The API client alone | Node and Workers |
| `@rivi-software/cloudflare-deploy/previous-assets` | The Worker half of [skew protection](#skew-protection) | Workers |
| `cloudflare-retain-assets` (bin) | The deploy half of skew protection | Node |

In Worker code, import from the subpaths: the main entry also pulls in `node:child_process` and `node:fs` through the process helpers.

## Deploy scripts

- **Environment guards.**
  - `requireEnv(name)` and `requireEnvMinLength(name, min)`.
  - `requireCloudflareAccountId(env, name = "CLOUDFLARE_ACCOUNT_ID")`: 32 lowercase hexadecimal characters, the form Cloudflare's account IDs take.
  - `assertProductionBuildBranch(env, branch = "main")` refuses a production deploy on GitHub Actions unless it is a push or a manual run on `branch`, and on Cloudflare Workers Builds unless `WORKERS_CI_BRANCH` is `branch`. Elsewhere, such as a deploy from your own machine, it passes.

  Each guard takes an optional `env` record (default `process.env`).
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
  assertProductionBuildBranch,
  checkDeploymentHealth,
  requireCloudflareAccountId,
  requireEnv,
  runOrThrow,
  wranglerCommand,
} from "@rivi-software/cloudflare-deploy";

assertProductionBuildBranch();
const accountId = requireCloudflareAccountId();
requireEnv("CLOUDFLARE_API_TOKEN");
await runOrThrow(wranglerCommand(["deploy"]), {
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
});
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
| `checkDeploymentHealth(origin, options?)` | Polls a fresh deployment until it answers; options `paths`, `validate`, `attempts`, `delayMs`, `timeoutMs` |
| `runCommand(args, options?)`, `runOrThrow(args, options?)` | Run a command; options `cwd`, `env`, `input` (written to stdin) and `capture` (collect the output) |
| `binPath(name, from?)`, `wranglerCommand(args, from?)`, `nodeScript(script, args?)` | The arguments that run a project's binary, its Wrangler, or a TypeScript file through `tsx` |
| `cloudflareApiToken(env?)` | `CLOUDFLARE_API_TOKEN`, else the token `wrangler login` holds |
| `sleep(ms)`, `fileExists(path)` | A pause; whether a regular file exists |
| `RETAIN_DAYS`, `retainBuildAssets(input)`, `planRetention(input)`, `readBuildFiles(clientDir)`, `previousAssetsTarget(config, configPath, env?)` | The deploy half of [skew protection](#skew-protection) |
| Everything from `/cloudflare-api`, and from `/previous-assets` all but `assetKey` | |
| Types | `Env`, `HealthCheckOptions`, `RunOptions`, `RunResult`, `AssetDeployConfig`, `AssetRecord`, `RetentionPlan` |

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

## Development

The tests in `tests/` cover:
- the environment guards
- the health check
- the API client, against a fake `fetch`
- the retention plan, and the deploy against a fake store
- the Worker's fallback

None of them calls Cloudflare. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

[MIT](LICENSE)
