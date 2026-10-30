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
  - `requireCloudflareAccountId()`: 32 lowercase hexadecimal characters.
  - `assertProductionBuildBranch(env, branch = "main")` refuses a production deploy on GitHub Actions unless it is a push or a manual run on `branch`, and on Cloudflare Workers Builds unless `WORKERS_CI_BRANCH` is `branch`. Elsewhere, such as a deploy from your own machine, it passes.

  Each guard takes an optional `env` record (default `process.env`).
- **Health check.** `checkDeploymentHealth(origin, options)` polls a fresh deployment until one of `paths` answers `2xx`.
  - It retries network errors and the statuses a deployment answers while it propagates (404, 429, 500, 502, 503, 504).
  - Any other status fails at once, because then the deployment is wrong rather than late.
  - The default window (16 attempts, 4 s apart) outlasts a custom domain's rollout, during which the previous version keeps answering for tens of seconds after `wrangler deploy`.
  - `validate` checks the body of the response that passed.
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
- `dispatch`: Workers for Platforms namespace scripts (upload, list by tag, secrets, tags, delete)
- `call` and `maybe`, for any other endpoint

It uses only `fetch`, `FormData` and `Blob`.

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

The account comes from the config's `account_id`, else `CLOUDFLARE_ACCOUNT_ID`. The token comes from `CLOUDFLARE_API_TOKEN`, else `wrangler login`, and needs **Workers KV Storage: Edit**. Each request is sent up to five times, over about 15 s, while Cloudflare answers a passing `internal error`. The build is labelled with `GITHUB_SHA`, else `WORKERS_CI_COMMIT_SHA`.

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
