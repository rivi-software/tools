import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { build } from "vite";
import { afterAll } from "vitest";

/** A directory, by its real path, removed after the test file's tests. */
export const temporaryDirectory = (): string => {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "workers-bundle-check-"))
  );

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
};

/** Writes each file of `files`, by its path under `dir`. */
export const write = (dir: string, files: Record<string, string>): void => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
};

/**
 * A key shaped like Stripe's secret test key, put together here so that no secret scanner finds
 * one in this repository. It is the example key Stripe's documentation publishes.
 */
export const STRIPE_TEST_KEY = ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join(
  "_"
);

/**
 * A Worker project to build:
 * - `src/index.ts` imports `src/util.ts`, `fake-mock` (an npm layout) and `icons` (a pnpm layout,
 *   behind a symlink), loads `src/lazy.ts` lazily, and imports `src/shaken.ts` without using it
 * - `src/mocks/handlers.ts` and the package `unused-dep` (with the marker `UNUSED_DEP`) are
 *   there, and nothing imports them
 * - `fake-mock` carries a value shaped like a Stripe secret key, and the marker `FAKE_MOCK_ACTIVE`
 */
export const workerProject = (): string => {
  const dir = temporaryDirectory();
  write(dir, {
    "src/index.ts": [
      'import { greet } from "./util";',
      'import { neverCalled } from "./shaken";',
      'import { setupMock } from "fake-mock";',
      'import { star } from "icons";',
      "export default {",
      "  async fetch(request: Request) {",
      "    const url = new URL(request.url);",
      '    if (url.pathname === "/mock") return new Response(setupMock());',
      '    if (url.pathname === "/lazy") return new Response((await import("./lazy")).lazy());',
      "    return new Response(greet(url.pathname) + star);",
      "  },",
      "};",
      "void neverCalled;",
    ].join("\n"),
    "src/util.ts":
      // oxlint-disable-next-line eslint/no-template-curly-in-string -- this is the source of the test project's module, which has a template literal of its own
      "export function greet(name: string) { return `hello ${name}`; }\n",
    "src/shaken.ts":
      'export function neverCalled() { return "SHAKEN_AWAY"; }\n',
    "src/lazy.ts": 'export function lazy() { return "lazy chunk"; }\n',
    "src/mocks/handlers.ts": 'export const handlers = ["DEV_ONLY_HANDLERS"];\n',
    "node_modules/fake-mock/package.json": JSON.stringify({
      name: "fake-mock",
      version: "1.0.0",
      type: "module",
      main: "lib/index.js",
      sideEffects: false,
    }),
    "node_modules/fake-mock/lib/index.js": [
      `const key = "${STRIPE_TEST_KEY}";`,
      'export function setupMock() { return "FAKE_MOCK_ACTIVE " + key; }',
    ].join("\n"),
    "node_modules/.pnpm/icons@1.0.0/node_modules/icons/package.json":
      JSON.stringify({
        name: "icons",
        version: "1.0.0",
        type: "module",
        main: "dist/index.js",
        sideEffects: false,
      }),
    "node_modules/.pnpm/icons@1.0.0/node_modules/icons/dist/index.js":
      'export * from "./icons/all.js";\n',
    "node_modules/.pnpm/icons@1.0.0/node_modules/icons/dist/icons/all.js":
      'export const star = "<svg>star</svg>";\nexport const moon = "<svg>moon</svg>";\n',
    "node_modules/unused-dep/package.json": JSON.stringify({
      name: "unused-dep",
      version: "1.0.0",
    }),
    "node_modules/unused-dep/index.js": 'export const marker = "UNUSED_DEP";\n',
  });
  symlinkSync(
    ".pnpm/icons@1.0.0/node_modules/icons",
    path.join(dir, "node_modules/icons"),
    "dir"
  );

  return dir;
};

/** Builds the project's Worker with Vite (Rolldown) into `outDir`, minified, as an SSR build. */
export const viteBuild = async (
  root: string,
  {
    outDir = "dist/server",
    sourcemap = true,
  }: { outDir?: string; sourcemap?: boolean | "hidden" | "inline" } = {}
): Promise<void> => {
  await build({
    configFile: false,
    root,
    logLevel: "silent",
    ssr: { noExternal: true },
    build: {
      ssr: "src/index.ts",
      outDir,
      emptyOutDir: true,
      minify: true,
      sourcemap,
      rolldownOptions: { external: [/^cloudflare:/u] },
    },
  });
};

const wranglerBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js"
);

/** Runs the project's Wrangler in `cwd` and returns its output. */
export const wrangler = async (
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<string> => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [wranglerBin, ...args],
    {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: path.join(cwd, ".wrangler-logs"),
        ...env,
      },
    }
  );

  return stdout + stderr;
};

/** Builds the project's Worker as `wrangler deploy` does (esbuild), with its source map, into `outDir`. */
export const wranglerBuild = async (
  root: string,
  outDir = "dist/wrangler"
): Promise<void> => {
  write(root, {
    "wrangler.json": JSON.stringify({
      name: "workers-bundle-check-test",
      main: "src/index.ts",
      compatibility_date: "2026-11-01",
      upload_source_maps: true,
    }),
  });
  await wrangler(root, ["deploy", "--dry-run", "--minify", "--outdir", outDir]);
};
