import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  checkWorkerBundle,
  type WorkerBundleCheckOptions,
  type WorkerBundleReport,
} from "./check.js";

/** The configuration files the command looks for in the current directory, in this order. */
export const CONFIG_FILES = [
  "workers-bundle-check.config.ts",
  "workers-bundle-check.config.mts",
  "workers-bundle-check.config.js",
  "workers-bundle-check.config.mjs",
  "workers-bundle-check.config.json",
];

export const USAGE = `Usage: workers-bundle-check [--config <file>] [--server <dir>] [--assets <dir>]

Checks a Worker's build: no forbidden module or marker in the Worker, no source
map among the assets Wrangler would serve, and no value shaped like a secret.
Run it after the build.

  --config   A module whose default export holds the options. Default: the
             first of workers-bundle-check.config.ts, .mts, .js, .mjs and .json
             that exists. A JSON file holds no regular expressions.
  --server   The Worker's build output, such as dist/server (the option serverDir)
  --assets   Its static assets directory, such as dist/client (the option assetsDir)

Paths are relative to the current directory.`;

type Context = {
  /** The directory paths are relative to. */
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
};

/** Runs `workers-bundle-check` with `args` and returns its exit code. */
export async function runCli(
  args: string[],
  context: Context = { cwd: process.cwd(), log: console.log, error: console.error },
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      options: {
        config: { type: "string" },
        server: { type: "string" },
        assets: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    context.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    context.log(USAGE);
    return 0;
  }

  try {
    const found = values.config
      ? path.resolve(context.cwd, values.config)
      : CONFIG_FILES.map((file) => path.join(context.cwd, file)).find((file) => existsSync(file));
    if (values.config && !existsSync(found!)) {
      context.error(`There is no configuration file at ${values.config}.`);
      return 2;
    }
    const config = found ? await loadConfig(found) : {};
    const serverDir = values.server ?? config.serverDir;
    if (!serverDir) {
      context.error(
        `Name the Worker's build output: --server <dir>, or serverDir in ${found ? path.relative(context.cwd, found) : CONFIG_FILES[0]}.\n\n${USAGE}`,
      );
      return 2;
    }
    const report = await checkWorkerBundle({
      ...config,
      cwd: path.resolve(context.cwd, config.cwd ?? "."),
      serverDir,
      assetsDir: values.assets ?? config.assetsDir,
    });
    for (const line of summary(report, config)) context.log(line);
    return 0;
  } catch (error) {
    context.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** The options a configuration file's default export holds. */
async function loadConfig(file: string): Promise<Partial<WorkerBundleCheckOptions>> {
  const config: unknown = file.endsWith(".json")
    ? JSON.parse(await readFile(file, "utf8"))
    : ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error(`${file} must export the options as its default export: { serverDir, … }.`);
  return config as Partial<WorkerBundleCheckOptions>;
}

/** What a passing check read, line by line. */
function summary(report: WorkerBundleReport, config: Partial<WorkerBundleCheckOptions>): string[] {
  const rules = config.forbidden?.length ?? 0;
  const files = report.workerFiles.length;
  const lines = [
    `${report.serverDir}: ${files} file${files === 1 ? "" : "s"} and ${report.modules} module${report.modules === 1 ? "" : "s"}, none that ${rules} forbidden rule${rules === 1 ? "" : "s"} name.`,
  ];
  if (report.assetsDir !== undefined)
    lines.push(
      `${report.assetsDir}: ${report.servedAssets} file${report.servedAssets === 1 ? "" : "s"} served and ${report.ignoredAssets} left out, no source map among them.`,
    );
  lines.push(
    `No value shaped like a secret${report.allowedSecrets ? `, but the ${report.allowedSecrets} allowed` : ""}.`,
  );
  return lines;
}
