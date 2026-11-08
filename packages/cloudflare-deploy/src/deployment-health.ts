import { sleep as defaultSleep } from "./process.js";

/** HTTP statuses that a Worker returns while a deployment is still propagating; retried. */
const TRANSIENT_STATUSES = new Set([404, 429, 500, 502, 503, 504]);

export interface HealthCheckOptions {
  /** Paths tried in order on every attempt; the first `2xx` response passes. Default `/`. */
  paths?: string[];
  /** Validates a `2xx` response body; throw to fail the check without retrying. */
  validate?: (response: Response) => Promise<void> | void;
  /** Rounds over `paths` before the check fails. Default 16. */
  attempts?: number;
  /** Pause between attempts, in milliseconds. Default 4000. */
  delayMs?: number;
  /** How long one request may take, in milliseconds. Default 30,000. */
  timeoutMs?: number;
  /** The pause itself; tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls a freshly deployed origin until it answers. Transient statuses and network errors are
 * retried; any other failing status fails the check at once, because the deployment is wrong
 * rather than late. The default window (a minute of pauses) outlasts a custom domain's rollout,
 * during which the previous version keeps answering for tens of seconds after `wrangler deploy`.
 * Redirects are not followed: one fails the attempt like a network error, so pass the origin that
 * answers.
 */
export const checkDeploymentHealth = async (
  origin: string,
  options: HealthCheckOptions = {}
) => {
  const {
    paths = ["/"],
    validate,
    attempts = 16,
    delayMs = 4000,
    timeoutMs = 30_000,
    sleep = defaultSleep,
  } = options;

  const base = origin.replace(/\/$/u, "");
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const path of paths) {
      let response: Response | undefined;

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each path is tried in turn and the first that answers ends the check
        response = await fetch(`${base}${path}`, {
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error;
      }

      if (response?.ok) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the check ends here, so nothing runs alongside this
        await validate?.(response);

        return;
      }

      if (response) {
        lastError = new Error(
          `Deployment health check failed (HTTP ${response.status})`
        );

        if (!TRANSIENT_STATUSES.has(response.status)) {
          throw lastError;
        }
      }
    }

    if (attempt < attempts - 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- attempts are spaced out in time, so they must be sequential
      await sleep(delayMs);
    }
  }

  throw lastError;
};
