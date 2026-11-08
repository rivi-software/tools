import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCommand, wranglerCommand } from "@rivi-software/cloudflare-deploy";
import type { RunOptions, RunResult } from "@rivi-software/cloudflare-deploy";

import { previewName } from "./name.js";

/** What `deployPreview` deploys, and how it runs Wrangler. */
export interface DeployPreviewOptions {
  /** The branch the Preview is for; its `previewName` names the Preview. */
  branch: string;
  /** The branch production deploys from, which gets no Preview. Default `main`. */
  productionBranch?: string;
  /**
   * The Worker, passed to Wrangler as `--worker-name`. Without it Wrangler takes the name from its
   * config, or from `WRANGLER_CI_OVERRIDE_NAME` on Workers Builds.
   */
  worker?: string;
  /** More arguments for `wrangler preview`, such as `--config` or `--secrets-file`; not `--name`. */
  args?: readonly string[];
  /** The directory Wrangler runs in, and finds its config in. Default the current one. */
  cwd?: string;
  /** Wrangler's environment. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Runs a command to completion; default `runCommand` from `@rivi-software/cloudflare-deploy`. */
  run?: (args: string[], options: RunOptions) => Promise<RunResult>;
}

/** What `wrangler preview` reported for this run. */
export interface DeployedPreview {
  worker: string;
  name: string;
  id: string;
  /** The Preview's own URLs, which follow its latest deployment. Empty when Preview URLs are off. */
  urls: string[];
  deploymentId: string;
  /** This deployment's URLs, which keep serving it after later deployments. */
  deploymentUrls: string[];
}

/** `--name` and `--worker-name` are this command's to set. */
const OWN_FLAGS = /^--(?:name|worker-name)(?:=|$)/u;

/** Whether a field of Wrangler's output holds a string. */
const isString = (value: unknown): value is string => typeof value === "string";

/** The strings of a field that should hold a list of them, and none for anything else. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Wrangler's output is JSON off disk, so a field is unknown until this looks at it
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(isString) : [];

/** A line of Wrangler's output file. Each field is read, and checked, where it is used. */
interface WranglerRecord {
  type?: unknown;
  version?: unknown;
  preview_name?: unknown;
  preview_id?: unknown;
  preview_urls?: unknown;
  worker_name?: unknown;
  deployment_id?: unknown;
  deployment_urls?: unknown;
}

/**
 * The one Preview record in the contents of Wrangler's output file, checked against the name and,
 * when given, the Worker it was deployed under. Throws for none, for more than one, and for a
 * record of another Preview.
 */
export const readPreviewResult = (
  output: string,
  expected: { name: string; worker?: string }
): DeployedPreview => {
  const records = output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        // SAFETY: every field of the parsed line is read as unknown and checked before it is used.
        return JSON.parse(line) as WranglerRecord;
      } catch {
        throw new Error("Wrangler's output file holds a line that is not JSON");
      }
    })
    .filter((record) => record?.type === "preview");

  if (records.length !== 1) {
    throw new Error(
      `Expected one Preview in Wrangler's output, found ${records.length}`
    );
  }

  const [record] = records;

  if (record.version !== 1) {
    throw new Error(
      `Wrangler's Preview record has version ${String(record.version)}, not 1`
    );
  }

  if (record.preview_name !== expected.name) {
    throw new Error(
      `Wrangler deployed the Preview ${String(record.preview_name)}, not ${expected.name}`
    );
  }

  const worker = record.worker_name;

  if (!isString(worker)) {
    throw new Error("Wrangler's Preview record names no Worker");
  }

  if (expected.worker && worker !== expected.worker) {
    throw new Error(
      `Wrangler deployed to the Worker ${worker}, not ${expected.worker}`
    );
  }

  return {
    worker,
    name: expected.name,
    id: String(record.preview_id ?? ""),
    urls: strings(record.preview_urls),
    deploymentId: String(record.deployment_id ?? ""),
    deploymentUrls: strings(record.deployment_urls),
  };
};

/** Copies this run's records where the environment asked Wrangler to write them, as Wrangler would. */
const forwardOutput = async (
  output: string,
  env: Record<string, string | undefined>,
  cwd: string
) => {
  if (!output) {
    return;
  }

  if (env.WRANGLER_OUTPUT_FILE_PATH) {
    const file = path.resolve(cwd, env.WRANGLER_OUTPUT_FILE_PATH);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, output);
  } else if (env.WRANGLER_OUTPUT_FILE_DIRECTORY) {
    const dir = path.resolve(cwd, env.WRANGLER_OUTPUT_FILE_DIRECTORY);

    const date = new Date()
      .toISOString()
      .replaceAll(":", "-")
      .replace(".", "_")
      .replace("T", "_")
      .replace("Z", "");

    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(
        dir,
        `wrangler-output-${date}-${randomBytes(3).toString("hex")}.json`
      ),
      output
    );
  }
};

/**
 * Runs `wrangler preview` for a branch under its `previewName`, and answers what Wrangler reported.
 * Wrangler appends a record per command to its output file, so the result is read from a new, empty
 * file of this run's own; when the environment names an output file or directory, the records are
 * copied there afterwards. Throws when Wrangler fails, or when its output holds no Preview of this
 * name and Worker.
 */
export const deployPreview = async (
  options: DeployPreviewOptions
): Promise<DeployedPreview> => {
  const name = previewName(options.branch, {
    productionBranch: options.productionBranch,
    worker: options.worker,
  });

  const args = options.args ?? [];
  const own = args.find((arg) => OWN_FLAGS.test(arg));

  if (own) {
    throw new Error(
      `Leave ${own.split("=")[0]} out of Wrangler's arguments: the Preview's name comes from its branch`
    );
  }

  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? runCommand;

  const dir = await mkdtemp(path.join(tmpdir(), "workers-previews-"));

  try {
    const outputPath = path.join(dir, "wrangler-output.json");
    await writeFile(outputPath, "", { mode: 0o600 });

    const command = wranglerCommand(
      [
        "preview",
        "--name",
        name,
        ...(options.worker ? ["--worker-name", options.worker] : []),
        ...args,
      ],
      cwd
    );

    const { code } = await run(command, {
      cwd,
      env: { ...env, WRANGLER_OUTPUT_FILE_PATH: outputPath },
    });

    const output = await readFile(outputPath, "utf-8");
    await forwardOutput(output, env, cwd);

    if (code !== 0) {
      throw new Error(`wrangler preview failed (exit ${code})`);
    }

    return readPreviewResult(output, { name, worker: options.worker });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
