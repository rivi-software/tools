/**
 * The GET requests scripts/mirror-github-packages.ts makes to npm and GitHub Packages. Each try
 * has 30 seconds to answer in full, its body included, so a registry that stops answering fails
 * the request instead of holding the release workflow. A try that timed out, did not reach the
 * registry, or found it busy (429) or failing (5xx) is followed by another, up to three tries in
 * all. The next try waits as long as a busy answer's Retry-After asks, up to 30 seconds, and
 * otherwise 2 and then 4 seconds.
 */
import { setTimeout as sleep } from "node:timers/promises";

/** A registry's answer, its body read in full. */
export interface Answer {
  ok: boolean;
  status: number;
  body: Buffer;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** How long one try has to answer in full. */
  timeoutMs?: number;
  /** The wait before the second try; the third waits twice that. */
  retryMs?: number;
  /** The longest wait a busy answer's Retry-After gets. */
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
}

const TRIES = 3;

/** An answer a later try can change: the registry was busy or failing. */
const isBusy = (status: number): boolean => status === 429 || status >= 500;

/**
 * The wait, in milliseconds, that a Retry-After header asks for, as a number of seconds or as an
 * HTTP date. Undefined when there is none, or none that parses.
 */
const retryAfter = (header: string | null): number | undefined => {
  if (header === null) {
    return undefined;
  }

  const ms = /^\d+$/u.test(header.trim())
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();

  return Number.isNaN(ms) ? undefined : Math.max(ms, 0);
};

/**
 * Why a try that threw failed: its deadline, or the error fetch threw. When the registry could
 * not be reached, that is a TypeError ("fetch failed") whose cause names the connection's error.
 */
const failure = (
  error: Error,
  signal: AbortSignal,
  timeoutMs: number
): string => {
  if (signal.aborted) {
    return `gave no full answer within ${timeoutMs / 1000} seconds`;
  }

  return error.cause instanceof Error
    ? `${error.message}: ${error.cause.message}`
    : error.message;
};

/**
 * The registry's answer to a GET of `url`. A 429 or 5xx on the last try is returned as it is; a
 * last try that timed out or did not reach the registry throws.
 */
export const request = async (
  url: string,
  options: RequestOptions = {},
  tried = 0
): Promise<Answer> => {
  const {
    headers = {},
    timeoutMs = 30_000,
    retryMs = 2000,
    maxWaitMs = 30_000,
    fetchImpl = fetch,
  } = options;

  const last = tried + 1 === TRIES;
  const signal = AbortSignal.timeout(timeoutMs);
  let why: string;
  let asked: number | undefined;

  try {
    const response = await fetchImpl(url, { headers, signal });
    // Read under the same deadline: a registry can stop partway through a body.
    const body = Buffer.from(await response.arrayBuffer());

    if (!isBusy(response.status) || last) {
      return { body, ok: response.ok, status: response.status };
    }

    why = `answered ${response.status}`;
    asked = retryAfter(response.headers.get("retry-after"));
  } catch (error) {
    // SAFETY: fetch and the body's read reject with Errors, and so does the signal's deadline.
    why = failure(error as Error, signal, timeoutMs);

    if (last) {
      throw new Error(`${url} ${why}, on each of ${TRIES} tries`, {
        cause: error,
      });
    }
  }

  const wait =
    asked === undefined ? retryMs * (tried + 1) : Math.min(asked, maxWaitMs);

  console.log(`${url} ${why}: trying again in ${wait / 1000} seconds`);
  await sleep(wait);

  return request(url, options, tried + 1);
};
