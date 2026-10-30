# @rivi-software/posthog-tanstack-start

[PostHog](https://posthog.com) error tracking for [TanStack Start](https://tanstack.com/start) apps on Cloudflare Workers:
- the Worker's exceptions and events, through `posthog-node`
- Start middlewares that report what server functions and server routes throw
- the browser SDK, loaded after hydration
- redaction of routes whose address is a credential
- the source map upload

Your app keeps control of what it tracks: its own `posthog-js` options, such as consent, analytics and session replay.

```bash
npm install @rivi-software/posthog-tanstack-start posthog-node posthog-js
# for the source map upload
npm install --save-dev @posthog/rollup-plugin
```

The PostHog libraries are peer dependencies, so the app and this package share one SDK:
- `posthog-node`: `./server` and `./start` need it.
- `posthog-js`: only `./browser` needs it.
- `@posthog/rollup-plugin`: only `./vite` needs it.

The rollup plugin depends on `@posthog/cli`, whose build script pnpm 12 asks you to approve or deny. Deny it, because the CLI downloads its binary when it first runs: put `allowBuilds: { "@posthog/cli": false }` in `pnpm-workspace.yaml`.

It needs TanStack Start 1.169 or later (with TanStack Router 1.170 or later), Vite 6, 7 or 8, posthog-node 5.57.1 or later and posthog-js 1.438.21 or later. The package is ESM only.

## Entry points

| Entry point | Contents | Runs in |
| --- | --- | --- |
| `…/server` | `captureServerException`, `captureServerEvent`, `setSecretPaths`, `installPostHogForTests` | The Worker (`cloudflare:workers`) |
| `…/start` | `posthogFunctionErrors`, `posthogRequestErrors` (the Start middlewares), `getPostHogBrowserConfig` (the browser's settings, for the router's `dehydrate`) | TanStack Start, both sides |
| `…/browser` | `initPostHog(config, options)`, `withPostHog`, `captureClientException`, `redactSecretPaths`, `PostHogBrowserConfig` | The browser |
| `…/vite` | `posthogSourcemaps({ releaseName, releaseVersion })`, `PostHogSourcemapOptions` | Vite config |

TanStack Start compiles this package as it compiles the app's own code, because the package peer-depends on `@tanstack/react-start`. So the middlewares' server code and `getPostHogBrowserConfig` stay out of the browser's bundle.

## Configuration

| Variable | Where | What |
| --- | --- | --- |
| `POSTHOG_PROJECT_TOKEN` | Worker var | The project API key (`phc_…`). Empty turns PostHog off on both sides, with a console error in development. |
| `POSTHOG_HOST` | Worker var | The ingestion host: `https://us.i.posthog.com` (the default) or `https://eu.i.posthog.com` |
| `POSTHOG_PERSONAL_API_KEY` | Build env | Turns on the source map upload. Set it only on the build that deploys. |
| `POSTHOG_PROJECT_ID` | Build env | The project the maps go to |
| `POSTHOG_API_HOST` | Build env | The app host for the upload: `https://us.posthog.com` (the default) or `https://eu.posthog.com` |

One pair of Worker vars configures the browser and the Worker alike: `getPostHogBrowserConfig` reads them during SSR, and the router hands them to the client. Declare them in the Worker's `Env` (`wrangler types`).

## Usage

```ts
// vite.config.ts
import { posthogSourcemaps } from "@rivi-software/posthog-tanstack-start/vite";

export default defineConfig({
  plugins: [/* tanstackStart(), cloudflare(), … */ ...posthogSourcemaps({ releaseName: "web" })],
});
```

```ts
// src/start.ts
import { posthogFunctionErrors, posthogRequestErrors } from "@rivi-software/posthog-tanstack-start/start";

export const startInstance = createStart(() => ({
  requestMiddleware: [posthogRequestErrors],
  functionMiddleware: [posthogFunctionErrors],
}));
```

```tsx
// src/router.tsx
import { captureClientException, initPostHog } from "@rivi-software/posthog-tanstack-start/browser";
import { getPostHogBrowserConfig } from "@rivi-software/posthog-tanstack-start/start";

const router = createRouter({
  routeTree,
  dehydrate: () => ({ posthog: getPostHogBrowserConfig() }),
  hydrate: ({ posthog }) => initPostHog(posthog, { person_profiles: "identified_only" }),
  defaultOnCatch: (error) => captureClientException(error),
});
```

```ts
// Anywhere on the server: a failure the code answers or logs instead of throwing.
import { captureServerException } from "@rivi-software/posthog-tanstack-start/server";

captureServerException(error, { request, properties: { handler: "file-upload" } });
```

With [`@rivi-software/deploy-watch`](https://github.com/rivi-software/tools/tree/main/packages/deploy-watch#readme), report a router error only once it is not a missing chunk that reloads the page: `recoverFromChunkError(error).then((reloading) => reloading || captureClientException(error))`.

## How it works

- **The Worker.** `posthog-node` (its workerd build) sends every exception and event on its own (`captureExceptionImmediate`, `captureImmediate`) and keeps the send alive past the response with `waitUntil`. Nothing waits in a batch the isolate could drop.

  `captureServerException(error, { request, distinctId, properties })` sends the request's method, origin and path, never its query (which can hold a token or a search term). It also sends the browser's person and session, read from posthog-js' tracing headers on same-origin fetches, or from the SDK's cookie on a page load. That links the exception to the session replay.

  A handler that knows the person passes `distinctId`. `captureServerEvent(event, distinctId, properties, anonymousId)` sends any other event. Without a `distinctId` it sends the event anonymously (no person profile), under `anonymousId` when you pass one, so related events (one conversation's calls) share an id.

  Neither waits for PostHog or throws: a send that fails logs a `console.warn` line, and the handler's response goes out either way.
- **Secret paths.** A route whose address is a credential, such as a shared ticket's page `/t/$token`, reaches PostHog as its pattern, never as the link. List the patterns, as TanStack Router writes them, once for each side:
  - In the Worker's entry module, `setSecretPaths(patterns)` covers the exceptions' `$current_url` and `$pathname`.
  - In the posthog-js options, `before_send: redactSecretPaths(patterns)` covers every address an event or a person carries, an autocaptured link and the heatmap's keys included.

  Two things get past that:
  - Session replay's `$snapshot` is compressed and goes as it is. Keep replay off, or block those paths in the project settings.
  - posthog-js' flags request sends the person's first address past `before_send`. Set `advanced_disable_flags` when you use no feature flags.
- **The middlewares.** Server functions turn a thrown error into an error response, and server routes answer one with a 500, before the Worker's `fetch` sees it; the middlewares report them there. Redirects, `notFound` and a thrown `Response` are control flow, and go unreported.
- **The browser.** `initPostHog` loads posthog-js as its own chunk after hydration (about 100 kB gzipped), so no page waits for it. It applies the SDK defaults of 2026-05-30 and tracing headers to the page's own host, then the app's options over them.

  `withPostHog` runs a callback once the SDK has loaded (identify, reset, a custom event), and does nothing while PostHog is off. `captureClientException` reports what the router's error boundaries catch, which never reaches `window.onerror`.
- **Source maps.** `posthogSourcemaps` uploads the browser's maps and the server environments' maps as release `releaseName` at `releaseVersion`. The version defaults to `GITHUB_SHA`, else `WORKERS_CI_COMMIT_SHA`. The browser's maps are deleted after the upload, so they are never served. The server's stay on disk for Wrangler's own upload (`upload_source_maps`). Without `POSTHOG_PERSONAL_API_KEY` it returns no plugins, so a local build uploads nothing and needs no PostHog credentials.

## In your app's tests

`vi.mock` does not reach a module your test worker already imported, so a test swaps the client instead:
- `installPostHogForTests({ captureImmediate, captureExceptionImmediate })` puts a stand-in in its place.
- `installPostHogForTests(null)` turns PostHog off again.

Pin `POSTHOG_PROJECT_TOKEN` empty in your test config, so no test reports to your production project.

## Development

The package's tests run in Node: `vitest.config.ts` points `cloudflare:workers` at `tests/cloudflare-workers.ts`, a stand-in with the Worker vars and no request context. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

[MIT](LICENSE)
