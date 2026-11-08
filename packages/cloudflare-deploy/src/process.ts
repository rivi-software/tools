import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Collect stdout and stderr instead of inheriting the terminal. */
  capture?: boolean;
}

/** The exit code, and the output when `capture` was set (empty otherwise). */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Resolves a package binary (`node_modules/.bin/<name>`) from `from` upwards; falls back to PATH. */
export const binPath = (name: string, from: string = process.cwd()): string => {
  let dir = path.resolve(from);

  for (;;) {
    const candidate = path.join(dir, "node_modules", ".bin", name);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return name;
    }

    dir = parent;
  }
};

/** Runs a command to completion; a non-zero exit is a result, not an error. */
export const runCommand = (
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> =>
  // oxlint-disable-next-line promise/avoid-new -- a child process reports through events, not a promise
  new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: options.cwd,
      // SAFETY: RunOptions.env has the same shape as NodeJS.ProcessEnv, which adds only index signatures
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: [
        options.input === undefined ? "inherit" : "pipe",
        options.capture ? "pipe" : "inherit",
        options.capture ? "pipe" : "inherit",
      ],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf-8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });

/** Runs a command and throws when it exits non-zero. */
export const runOrThrow = async (
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> => {
  const result = await runCommand(args, options);

  if (result.code !== 0) {
    throw new Error(
      `${args.slice(0, 3).join(" ")} failed (exit ${result.code})`
    );
  }

  return result;
};

/** A Wrangler invocation through the app's own dependency. */
export const wranglerCommand = (args: string[], from?: string): string[] => [
  binPath("wrangler", from),
  ...args,
];

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * A token for the REST API: `CLOUDFLARE_API_TOKEN` (CI), else the one an operator's
 * `wrangler login` holds.
 */
export const cloudflareApiToken = async (
  env: Record<string, string | undefined> = process.env
): Promise<string> => {
  if (env.CLOUDFLARE_API_TOKEN) {
    return env.CLOUDFLARE_API_TOKEN;
  }

  // `--json`: the plain output starts with Wrangler's banner.
  const { code, stdout } = await runCommand(
    wranglerCommand(["auth", "token", "--json"]),
    {
      capture: true,
    }
  );

  let token: unknown;

  try {
    // SAFETY: only the `token` property is read, and it stays `unknown` until checked below
    ({ token } = JSON.parse(stdout) as { token?: unknown });
  } catch {
    token = undefined;
  }

  if (code !== 0 || !isNonEmptyString(token)) {
    throw new Error("Set CLOUDFLARE_API_TOKEN or log in with `wrangler login`");
  }

  return token;
};

/** The current Node binary running a TypeScript entry through tsx, for child scripts. */
export const nodeScript = (script: string, args: string[] = []): string[] => [
  // tsx still registers its loader with module.register(); Node 26 warns about that on every run.
  process.execPath,
  "--disable-warning=DEP0205",
  "--import",
  "tsx",
  script,
  ...args,
];

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form that works on Workers and Node alike
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** True for an existing regular file; directories and missing paths are false. */
export const fileExists = (filePath: string) =>
  stat(filePath).then(
    (info) => info.isFile(),
    () => false
  );
