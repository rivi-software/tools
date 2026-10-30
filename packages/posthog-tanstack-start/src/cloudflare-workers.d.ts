// What `src/server.ts` and `src/start.ts` use of the Workers runtime module. An app declares the whole module with
// its own `Env` (`wrangler types`); this stands in for the package's own check, and `vitest.config.ts` points the
// tests at `tests/cloudflare-workers.ts`.
declare module "cloudflare:workers" {
  export const env: { POSTHOG_PROJECT_TOKEN?: string; POSTHOG_HOST?: string };
  export function waitUntil(promise: Promise<unknown>): void;
}
