const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;

export type Env = Record<string, string | undefined>;

export function requireEnv(name: string, env: Env = process.env): string {
  const value = env[name];
  if (value == null || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Cloudflare account IDs are 32 lowercase hexadecimal characters. */
export function requireCloudflareAccountId(
  env: Env = process.env,
  name = "CLOUDFLARE_ACCOUNT_ID",
): string {
  const value = requireEnv(name, env);
  if (!CLOUDFLARE_ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error(
      `${name} must be exactly 32 lowercase hexadecimal characters (a-f, 0-9). ` +
        "Set it to the account ID on the Cloudflare dashboard's account overview.",
    );
  }
  return value;
}

/**
 * Refuses a production deploy from anywhere but `branch`, before it reads or writes anything: on
 * GitHub Actions, a run that is not a push or a manual run on the branch; on Cloudflare Workers
 * Builds, a build of another branch (a preview trigger pointed at the production deploy). Elsewhere,
 * such as a person deploying from their machine, it passes.
 */
export function assertProductionBuildBranch(env: Env = process.env, branch = "main") {
  if (
    env.GITHUB_ACTIONS === "true" &&
    (env.GITHUB_REF !== `refs/heads/${branch}` ||
      !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? ""))
  )
    throw new Error(
      `GitHub production deployment requires a ${branch} push or manual ${branch} run`,
    );
  if (env.WORKERS_CI === "1" && env.WORKERS_CI_BRANCH !== branch)
    throw new Error(`Cloudflare production deployment requires WORKERS_CI_BRANCH=${branch}`);
}

export function requireEnvMinLength(
  name: string,
  minLength: number,
  env: Env = process.env,
): string {
  const value = requireEnv(name, env);
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }
  return value;
}
