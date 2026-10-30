import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type RunOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Collect stdout and stderr instead of inheriting the terminal. */
  capture?: boolean;
};

/** The exit code, and the output when `capture` was set (empty otherwise). */
export type RunResult = { code: number; stdout: string; stderr: string };

/** Resolves a package binary (`node_modules/.bin/<name>`) from `from` upwards; falls back to PATH. */
export function binPath(name: string, from: string = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return name;
    dir = parent;
  }
}

/** Runs a command to completion; a non-zero exit is a result, not an error. */
export function runCommand(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((settle, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: options.cwd,
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: [
        options.input === undefined ? "inherit" : "pipe",
        options.capture ? "pipe" : "inherit",
        options.capture ? "pipe" : "inherit",
      ],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => settle({ code: code ?? 1, stdout, stderr }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Runs a command and throws when it exits non-zero. */
export async function runOrThrow(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await runCommand(args, options);
  if (result.code !== 0)
    throw new Error(`${args.slice(0, 3).join(" ")} failed (exit ${result.code})`);
  return result;
}

/** A Wrangler invocation through the app's own dependency. */
export function wranglerCommand(args: string[], from?: string): string[] {
  return [binPath("wrangler", from), ...args];
}

/**
 * A token for the REST API: `CLOUDFLARE_API_TOKEN` (CI), else the one an operator's
 * `wrangler login` holds.
 */
export async function cloudflareApiToken(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  // `--json`: the plain output starts with Wrangler's banner.
  const { code, stdout } = await runCommand(wranglerCommand(["auth", "token", "--json"]), {
    capture: true,
  });
  let token: unknown;
  try {
    token = (JSON.parse(stdout) as { token?: unknown }).token;
  } catch {
    token = undefined;
  }
  if (code !== 0 || typeof token !== "string" || !token)
    throw new Error("Set CLOUDFLARE_API_TOKEN or log in with `wrangler login`");
  return token;
}

/** The current Node binary running a TypeScript entry through tsx, for child scripts. */
export function nodeScript(script: string, args: string[] = []): string[] {
  // tsx still registers its loader with module.register(); Node 26 warns about that on every run.
  return [process.execPath, "--disable-warning=DEP0205", "--import", "tsx", script, ...args];
}

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((settle) => setTimeout(settle, ms));

/** True for an existing regular file; directories and missing paths are false. */
export const fileExists = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
