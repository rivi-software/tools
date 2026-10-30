import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  build as viteBuild,
  createLogger,
  createServer,
  parseSync,
  type PluginOption,
  type Rolldown,
  type ViteDevServer,
} from "vite";
import { onTestFinished } from "vitest";

/** The Zod the tests run, linked into each project as its `node_modules/zod`. */
export const ZOD = dirname(createRequire(import.meta.url).resolve("zod/package.json"));

const RUNNER = fileURLToPath(new URL("./run-without-codegen.ts", import.meta.url));

/** A package.json for a package in a project's node_modules. */
export const manifest = (name: string, version = "1.0.0") =>
  JSON.stringify({ name, version, type: "module", sideEffects: false, exports: "./index.js" });

/**
 * An app whose dependency builds a schema as it loads, before any module of the app runs, and
 * whose entry reports whether its own schema still tells valid input from invalid.
 */
export const APP = {
  "node_modules/acme-forms/package.json": manifest("acme-forms"),
  "node_modules/acme-forms/index.js": `
    import { z } from "zod";
    export const Address = z.object({ city: z.string() });
  `,
  "src/main.js": `
    import { Address } from "acme-forms";
    import { z } from "zod";

    const Contact = z.object({ email: z.email(), address: Address });
    globalThis.result = {
      valid: Contact.safeParse({ email: "ada@example.com", address: { city: "Springfield" } }).success,
      invalid: Contact.safeParse({ email: "ada", address: {} }).success,
    };
  `,
};

/** A project in a temporary directory, removed when the test ends: `files` maps paths to contents. */
export function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zod-jitless-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(ZOD, join(root, "node_modules", "zod"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

export type Run = { attempts: string[]; result: unknown };

/** Runs `target`, a file or a URL in the JSON file `modules`, with code generation refused. */
export async function runWithoutCodegen(target: string, modules?: string): Promise<Run> {
  const args = ["--disallow-code-generation-from-strings", RUNNER, target];
  const { stdout } = await promisify(execFile)(
    process.execPath,
    modules ? [...args, modules] : args,
  );
  return JSON.parse(stdout);
}

/**
 * Builds `src/main.js` for the browser, or with `ssr` for the server, unminified into dist/main.js.
 * Returns the module ids in the bundle and the warnings the build logged.
 */
export async function build(
  root: string,
  plugins: PluginOption[],
  { ssr = false, treeshake }: { ssr?: boolean; treeshake?: Rolldown.TreeshakingOptions } = {},
) {
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => void warnings.push(message);
  logger.warnOnce = logger.warn;
  const output = (await viteBuild({
    root,
    configFile: false,
    logLevel: "silent",
    customLogger: logger,
    plugins,
    build: {
      ssr,
      minify: false,
      rolldownOptions: {
        input: join(root, "src/main.js"),
        output: { entryFileNames: "[name].js" },
        treeshake,
      },
    },
  })) as Rolldown.RolldownOutput;
  const modules = output.output.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : []));
  return { modules, warnings };
}

/** Vite's dev server for the project, listening until the test ends. */
export async function serve(root: string, plugins: PluginOption[]): Promise<ViteDevServer> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    server: { host: "127.0.0.1", port: 0 },
    optimizeDeps: { entries: ["src/main.js"] },
  });
  onTestFinished(() => server.close());
  await server.listen();
  return server;
}

/**
 * Serves the project with Vite's dev server, which pre-bundles its dependencies, and runs
 * `src/main.js` as a browser would: every module it imports, loaded from the server.
 */
export async function runInDev(root: string, plugins: PluginOption[]) {
  const server = await serve(root, plugins);
  const modules: Record<string, string> = {};
  const entry = new URL("/src/main.js", server.resolvedUrls?.local[0]).href;
  const pending = [entry];
  for (let url = pending.pop(); url; url = pending.pop()) {
    if (url in modules) continue;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
    const code = await response.text();
    modules[url] = code;
    const { module } = parseSync("module.js", code);
    for (const specifier of [
      ...module.staticImports.map((item) => item.moduleRequest.value),
      ...module.staticExports.flatMap((item) => item.entries.map((e) => e.moduleRequest?.value)),
    ])
      if (specifier) pending.push(new URL(specifier, url).href);
  }

  const file = join(root, "modules.json");
  writeFileSync(file, JSON.stringify(modules));
  return { modules, ...(await runWithoutCodegen(entry, file)) };
}

/**
 * The wrappers in a bundle, each as "<entry point> <module it wraps>", with the linked Zod's
 * directory as `zod` and the project's as `.`.
 */
export function wrappers(modules: string[], root: string): string[] {
  return modules
    .filter((id) => id.startsWith("\0zod-jitless:"))
    .map((id) => id.slice("\0zod-jitless:".length).replace(":", " "))
    .map((wrapper) => wrapper.replace(ZOD, "zod").replace(root, "."))
    .sort();
}
