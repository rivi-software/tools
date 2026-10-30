#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { cloudflareApi } from "./cloudflare-api.js";
import { cloudflareApiToken } from "./process.js";
import { previousAssetsTarget, retainBuildAssets } from "./retain-assets.js";

/**
 * `cloudflare-retain-assets --config <wrangler.json>`, run before `wrangler deploy` of the same
 * config: keeps the build's client files for tabs on earlier builds (./retain-assets.ts). The config
 * names the account, the build directory and the `PREVIOUS_ASSETS` store; the commit CI builds
 * (`GITHUB_SHA`, or `WORKERS_CI_COMMIT_SHA` on Workers Builds) labels the build. A Cloudflare
 * `internal error` is retried for about 15 seconds, so a passing one does not fail the deploy.
 */
async function main() {
  const [flag, configPath, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
  if (flag !== "--config" || !configPath || rest.length)
    throw new Error(
      "Usage: cloudflare-retain-assets --config <path to the deploy's wrangler.json>",
    );
  const target = previousAssetsTarget(JSON.parse(await readFile(configPath, "utf8")), configPath);
  await retainBuildAssets({
    api: cloudflareApi({
      accountId: target.accountId,
      token: await cloudflareApiToken(),
      retry: { attempts: 5 },
    }),
    namespaceId: target.namespaceId,
    clientDir: target.clientDir,
    build: process.env.GITHUB_SHA || process.env.WORKERS_CI_COMMIT_SHA || "local",
    log: console.log,
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
