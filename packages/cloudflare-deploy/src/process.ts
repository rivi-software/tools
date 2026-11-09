import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Collect stdout and stderr instead of inheriting the terminal. */
  capture?: boolean;
  /**
   * Runs the command up to `attempts` times while it exits non-zero and its output shows a
   * transient Cloudflare failure: a 5xx status, error code 10500, a malformed API response or a
   * network error. Pauses `delayMs` (default 1 s) before the second run and twice as long before
   * each next one. Any other failure ends it at once. Off by default; turn it on only for a
   * command that is safe to repeat. To read the output without `capture`, it pipes the output and
   * passes it on to this process's own as it comes, so the command sees no terminal.
   */
  retry?: {
    attempts: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

/** The last run's exit code, and its output when `capture` was set (empty otherwise). */
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

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form that works on Workers and Node alike
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Without `capture`, how much of each stream's end a retry reads: the error a command ends with. */
const OUTPUT_TAIL = 64 * 1024;

/** Signs in a command's output that Cloudflare failed rather than the command, as Wrangler prints them. */
const TRANSIENT_FAILURES: readonly RegExp[] = [
  // A 5xx status: "Failed to fetch … - 502: Bad Gateway", "GET … -> 503 Service Unavailable", "HTTP 500".
  / - 5\d{2}:| -> 5\d{2}\b|\b(?:HTTP|status(?: code)?):? 5\d{2}\b/iu,
  // Cloudflare's internal server error.
  /\[code: 10500\]/u,
  // An answer that is not the API's JSON, such as a gateway's error page.
  /Received a malformed response from the API/u,
  // The request failed on the way.
  /\bfetch failed\b|A fetch request failed|The request to Cloudflare's API timed out|Unable to resolve Cloudflare's API hostname|socket hang up|other side closed|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b/u,
];

const isTransientFailure = (output: string) =>
  TRANSIENT_FAILURES.some((pattern) => pattern.test(output));

/** The command as errors and warnings name it. */
const commandLabel = (args: string[]) => args.slice(0, 3).join(" ");

/** Collects a stream as text: all of it, or with `limit` its last `limit` characters. */
const collect = (stream: Readable | null, limit?: number) => {
  const decoder = new StringDecoder("utf-8");
  let text = "";
  stream?.on("data", (chunk: Buffer) => {
    text += decoder.write(chunk);

    if (limit !== undefined && text.length > limit) {
      text = text.slice(-limit);
    }
  });

  return () => text + decoder.end();
};

/**
 * Runs the command once. With `watch`, its output is piped even without `capture`, and passed on
 * to this process's own as it comes, byte for byte; `output` then holds its end.
 */
const runOnce = (args: string[], options: RunOptions, watch: boolean) =>
  // oxlint-disable-next-line promise/avoid-new -- a child process reports through events, not a promise
  new Promise<{ result: RunResult; output: string }>((resolve, reject) => {
    const capture = options.capture === true;
    const piped = capture || watch;

    const child = spawn(args[0], args.slice(1), {
      cwd: options.cwd,
      // SAFETY: RunOptions.env has the same shape as NodeJS.ProcessEnv, which adds only index signatures
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: [
        options.input === undefined ? "inherit" : "pipe",
        piped ? "pipe" : "inherit",
        piped ? "pipe" : "inherit",
      ],
    });

    if (watch && !capture) {
      child.stdout?.pipe(process.stdout, { end: false });
      child.stderr?.pipe(process.stderr, { end: false });
    }

    const limit = capture ? undefined : OUTPUT_TAIL;
    const stdout = collect(child.stdout, limit);
    const stderr = collect(child.stderr, limit);
    child.on("error", reject);
    child.on("close", (code) => {
      const out = stdout();
      const err = stderr();
      resolve({
        result: {
          code: code ?? 1,
          stdout: capture ? out : "",
          stderr: capture ? err : "",
        },
        output: `${out}\n${err}`,
      });
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });

/**
 * Runs a command to completion; a non-zero exit is a result, not an error. With `retry`, a run
 * that failed on a transient Cloudflare failure is run again.
 */
export const runCommand = async (
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> => {
  const attempts = options.retry?.attempts ?? 1;
  const pause = options.retry?.sleep ?? sleep;

  for (let attempt = 1; ; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a run starts only once the one before it failed
    const { result, output } = await runOnce(args, options, attempts > 1);

    if (
      result.code === 0 ||
      attempt >= attempts ||
      !isTransientFailure(output)
    ) {
      return result;
    }

    const delayMs = (options.retry?.delayMs ?? 1000) * 2 ** (attempt - 1);
    console.warn(
      `${commandLabel(args)} hit a transient Cloudflare failure (exit ${result.code}); running it again in ${delayMs / 1000} s (attempt ${attempt + 1} of ${attempts})`
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- runs back off in time, so they must be sequential
    await pause(delayMs);
  }
};

/** Runs a command as `runCommand` does, `retry` included, and throws when it exits non-zero. */
export const runOrThrow = async (
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> => {
  const result = await runCommand(args, options);

  if (result.code !== 0) {
    throw new Error(`${commandLabel(args)} failed (exit ${result.code})`);
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

/** True for an existing regular file; directories and missing paths are false. */
export const fileExists = (filePath: string) =>
  stat(filePath).then(
    (info) => info.isFile(),
    () => false
  );
