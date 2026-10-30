import { sleep as defaultSleep } from "./process.js";

/** HTTP statuses that a Worker returns while a deployment is still propagating; retried. */
const TRANSIENT_STATUSES = [404, 429, 500, 502, 503, 504];

export type HealthCheckOptions = {
  /** Paths tried in order on every attempt; the first `2xx` response passes. Default `/`. */
  paths?: string[];
  /** Validates a `2xx` response body; throw to fail the check without retrying. */
  validate?: (response: Response) => Promise<void> | void;
  attempts?: number;
  /** Pause between attempts, in milliseconds. */
  delayMs?: number;
  timeoutMs?: number;
  /** The pause itself; tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Polls a freshly deployed origin until it answers. Transient statuses and network errors are
 * retried; any other failing status fails the check at once, because the deployment is wrong
 * rather than late. The default window (a minute of pauses) outlasts a custom domain's rollout,
 * during which the previous version keeps answering for tens of seconds after `wrangler deploy`.
 */
export async function checkDeploymentHealth(origin: string, options: HealthCheckOptions = {}) {
  const {
    paths = ["/"],
    validate,
    attempts = 16,
    delayMs = 4000,
    timeoutMs = 30_000,
    sleep = defaultSleep,
  } = options;
  const base = origin.replace(/\/$/, "");
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const path of paths) {
      let response: Response | undefined;
      try {
        response = await fetch(`${base}${path}`, {
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error;
      }
      if (response?.ok) {
        await validate?.(response);
        return;
      }
      if (response) {
        lastError = new Error(`Deployment health check failed (HTTP ${response.status})`);
        if (!TRANSIENT_STATUSES.includes(response.status)) throw lastError;
      }
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  throw lastError;
}
