import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "./deploy-env.js";
import { runCommand, wranglerCommand } from "./process.js";

export type SecretsFileOptions = {
  /** Variables named `<prefix>_<NAME>` become the secret `<NAME>`. */
  prefix: string;
  /** The environment the secrets come from; `process.env` by default. */
  env?: Env;
  /**
   * Arguments that select the Worker for `wrangler secret list`, such as
   * `["--config", "dist/server/wrangler.json"]`. With them, once `run` has succeeded, a warning
   * names each secret on the Worker that no variable sets.
   */
  listSecrets?: string[];
};

/**
 * The secrets in the environment: each variable `<prefix>_<NAME>` becomes the secret `<NAME>`.
 * Throws, naming them, when such variables are empty. On GitHub Actions a secret that does not
 * exist reads as empty, and uploading it would blank the Worker's secret.
 */
export function secretsFromEnv(prefix: string, env: Env = process.env): Record<string, string> {
  const head = `${prefix.replace(/_$/, "")}_`;
  const secrets: Record<string, string> = {};
  const empty: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(head) || name === head || value === undefined) continue;
    if (value === "") empty.push(name);
    else secrets[name.slice(head.length)] = value;
  }
  if (empty.length)
    throw new Error(
      `Empty secret variables: ${empty.sort().join(", ")}. Set them, or leave them out of ` +
        "the environment so the Worker keeps its current values.",
    );
  return secrets;
}

/**
 * Writes the environment's `<prefix>_*` secrets (see `secretsFromEnv`) to a JSON file only its
 * owner can read, for `wrangler deploy --secrets-file` or `wrangler secret bulk`, and runs `run`
 * with its path. The file is deleted once `run` settles, also when it throws. Returns what `run`
 * returns.
 */
export async function withSecretsFile<T>(
  options: SecretsFileOptions,
  run: (path: string) => T | Promise<T>,
): Promise<T> {
  const secrets = secretsFromEnv(options.prefix, options.env);
  const result = await withPrivateFile("secrets.json", JSON.stringify(secrets), run);
  if (options.listSecrets)
    await warnUnsetSecrets(Object.keys(secrets), options.prefix, options.listSecrets);
  return result;
}

async function withPrivateFile<T>(
  name: string,
  content: string,
  run: (path: string) => T | Promise<T>,
): Promise<T> {
  // In the temporary directory, the file stays out of the build and anything that uploads it;
  // `mkdtemp` makes its directory 0700.
  const directory = await mkdtemp(join(tmpdir(), "cloudflare-secrets-"));
  try {
    const path = join(directory, name);
    await writeFile(path, content, { mode: 0o600 });
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function warnUnsetSecrets(set: string[], prefix: string, args: string[]) {
  const result = await runCommand(wranglerCommand(["secret", "list", ...args]), {
    capture: true,
  }).catch((error: unknown) => {
    console.warn(`Could not compare the Worker's secrets with ${prefix}_*: ${String(error)}`);
  });
  if (!result) return;
  const { code, stdout, stderr } = result;
  const names = code === 0 ? secretNames(stdout) : undefined;
  if (!names) {
    console.warn(
      `Could not compare the Worker's secrets with ${prefix}_*: wrangler secret list ` +
        (code === 0 ? "printed no list of secrets" : `failed (exit ${code})`) +
        (stderr.trim() ? `\n${stderr.trim()}` : ""),
    );
    return;
  }
  const unset = names.filter((name) => !set.includes(name)).sort();
  if (unset.length)
    console.warn(
      `Secrets on the Worker that no ${prefix}_* variable sets: ${unset.join(", ")}. A deploy ` +
        "keeps them; delete one that nothing reads with `wrangler secret delete <name>`.",
    );
}

/** The names in `wrangler secret list`'s JSON (`[{ "name": "FOO", "type": "secret_text" }]`). */
function secretNames(stdout: string): string[] | undefined {
  try {
    // From the first `[`, past anything Wrangler prints before the list.
    const list: unknown = JSON.parse(stdout.slice(stdout.indexOf("[")));
    if (!Array.isArray(list)) return undefined;
    return list.flatMap((secret: { name?: unknown } | null) =>
      typeof secret?.name === "string" ? [secret.name] : [],
    );
  } catch {
    return undefined;
  }
}
