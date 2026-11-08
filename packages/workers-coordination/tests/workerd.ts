import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const packageDir = path.join(import.meta.dirname, "..");

const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("typescript/package.json")
  ),
  "bin",
  "tsc"
);

/** The package as `pnpm run build` emits it, in a new directory, with the test Worker beside it. */
const build = async (): Promise<string> => {
  const dir = mkdtempSync(path.join(tmpdir(), "workers-coordination-"));
  await promisify(execFile)(process.execPath, [
    tsc,
    "-p",
    path.join(packageDir, "tsconfig.build.json"),
    "--outDir",
    dir,
    "--declaration",
    "false",
  ]);
  copyFileSync(
    path.join(import.meta.dirname, "fixtures", "worker.js"),
    path.join(dir, "worker.js")
  );

  return dir;
};

export interface Stored {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- whatever the test Worker's object has in storage, as JSON
  entries: Record<string, unknown>;
  alarm: number | null;
}

export interface Grant {
  token: string;
  expiresAt: number;
}

/**
 * `tests/fixtures/worker.js` in workerd through Miniflare, with `RATE_LIMITER` and `LOCKS` bound
 * to SQLite-backed namespaces of the package's classes. Each command is one request to it.
 */
export const startWorker = async (compatibilityDate = "2026-11-01") => {
  const dir = await build();

  const scripts = [
    "worker.js",
    ...readdirSync(dir).filter((file) => file !== "worker.js"),
  ].filter((file) => file.endsWith(".js"));

  const modules = scripts.map((file) => ({
    type: "ESModule" as const,
    path: path.join(dir, file),
  }));

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate,
      modulesRoot: dir,
      modules,
      durableObjects: {
        RATE_LIMITER: { className: "TestRateLimiter", useSQLite: true },
        LOCKS: { className: "TestLeaseLock", useSQLite: true },
      },
    })
  );

  await mf.ready;

  const command = async <T>(
    name: string,
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the arguments of any one command, sent as JSON
    args: Record<string, unknown>
  ): Promise<T> => {
    const response = await mf.dispatchFetch("http://worker/", {
      method: "POST",
      body: JSON.stringify({ command: name, ...args }),
    });

    if (!response.ok) {
      throw new Error(`${name}: ${response.status} ${await response.text()}`);
    }

    // SAFETY: each command's caller below names the type its handler in `fixtures/worker.js` answers.
    return (await response.json()) as T;
  };

  return {
    rateLimit: (
      key: string,
      options: { limit: number; windowSeconds: number }
    ) =>
      command<{ allowed: boolean; remaining: number; resetAt: number }>(
        "rateLimit",
        {
          key,
          ...options,
        }
      ),
    resetRateLimit: (key: string) => command<null>("resetRateLimit", { key }),
    acquireLease: (key: string, ttlMs: number) =>
      command<Grant | null>("acquireLease", { key, ttlMs }),
    renewLease: (token: string) =>
      command<{ expiresAt: number } | { lost: string }>("renewLease", {
        token,
      }),
    releaseLease: (token: string) =>
      command<boolean>("releaseLease", { token }),
    stored: (binding: "RATE_LIMITER" | "LOCKS", key: string) =>
      command<Stored>("stored", { binding, key }),
    async dispose() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
