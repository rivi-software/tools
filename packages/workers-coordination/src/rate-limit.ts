/**
 * `RateLimiter`, a Durable Object that counts the requests of one key in a fixed window, and
 * `rateLimit()`, its client. Each key has its own object (`idFromName(key)`), so a key has one
 * count wherever its requests come from. The object reads and writes the window with the
 * synchronous storage API inside one call, so simultaneous requests are counted one after the
 * other, and an alarm at the window's end empties its storage.
 */
import { DurableObject } from "cloudflare:workers";
import { type DurableObjectNamespaceLike, forget, objectFor } from "./objects.js";

/** How many requests a key may make, and over how long. */
export interface RateLimitOptions {
  /** How many requests a key may make in one window: a whole number, 1 or more. */
  readonly limit: number;
  /** How long a window lasts, in seconds, from the first request it counts. */
  readonly windowSeconds: number;
}

/** What `rateLimit()` answers for one request. */
export interface RateLimitResult {
  /** Whether the request is within the limit. A refused request is not counted. */
  readonly allowed: boolean;
  /** How many more requests the window allows. */
  readonly remaining: number;
  /** When the window ends and the count starts again, in milliseconds since the epoch. */
  readonly resetAt: number;
}

/** A key's current window, as its `RateLimiter` stores it. */
export interface RateLimitWindow {
  /** The requests the window has counted. */
  readonly count: number;
  /** When the window ends, in milliseconds since the epoch. */
  readonly resetAt: number;
}

/** The methods of a `RateLimiter` stub that the clients call. */
export interface RateLimiterStub {
  /** Counts one request for the object's key (`RateLimiter.consume`). */
  consume(options: RateLimitOptions): Promise<RateLimitResult>;
  /** Forgets the key's window (`RateLimiter.reset`). */
  reset(): Promise<void>;
}

/** Throws a `RangeError` for a limit or window that cannot count anything. */
export function assertRateLimitOptions(options: RateLimitOptions): void {
  const { limit, windowSeconds } = options ?? {};
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError(`limit must be a whole number, 1 or more, not ${limit}`);
  if (typeof windowSeconds !== "number" || !Number.isFinite(windowSeconds) || windowSeconds <= 0)
    throw new RangeError(`windowSeconds must be a number above 0, not ${windowSeconds}`);
}

/**
 * Counts one request at `now` against `window`. A window opens at the first request after the
 * last one ended, at `resetAt` or later, and keeps the end it opened with: a new `windowSeconds`
 * applies from the next window, a new `limit` at once.
 */
export function countRequest(
  window: RateLimitWindow | undefined,
  options: RateLimitOptions,
  now: number,
): { window: RateLimitWindow; result: RateLimitResult } {
  if (!window || now >= window.resetAt) {
    const opened = { count: 1, resetAt: now + Math.ceil(options.windowSeconds * 1000) };
    return {
      window: opened,
      result: { allowed: true, remaining: options.limit - 1, resetAt: opened.resetAt },
    };
  }
  if (window.count >= options.limit)
    return { window, result: { allowed: false, remaining: 0, resetAt: window.resetAt } };
  const counted = { count: window.count + 1, resetAt: window.resetAt };
  return {
    window: counted,
    result: { allowed: true, remaining: options.limit - counted.count, resetAt: counted.resetAt },
  };
}

const WINDOW = "window";

/**
 * The Durable Object behind `rateLimit()`: one object for each key. A Worker exports it and binds
 * it ([README](https://github.com/rivi-software/tools/tree/main/packages/workers-coordination#readme)).
 */
export class RateLimiter extends DurableObject<unknown> {
  /** Counts one request for this object's key. */
  async consume(options: RateLimitOptions): Promise<RateLimitResult> {
    assertRateLimitOptions(options);
    const { storage } = this.ctx;
    const current = storage.kv.get<RateLimitWindow>(WINDOW);
    const { window, result } = countRequest(current, options, Date.now());
    if (window !== current) storage.kv.put(WINDOW, window);
    if (window.resetAt !== current?.resetAt) await storage.setAlarm(window.resetAt);
    return result;
  }

  /** Forgets the key's window, so its next request opens a new one. */
  async reset(): Promise<void> {
    await forget(this.ctx.storage);
  }

  /** The window has ended: the object keeps nothing for an idle key. */
  async alarm(): Promise<void> {
    const window = this.ctx.storage.kv.get<RateLimitWindow>(WINDOW);
    if (window && window.resetAt > Date.now()) await this.ctx.storage.setAlarm(window.resetAt);
    else await forget(this.ctx.storage);
  }
}

/**
 * Counts one request for `key` in `namespace`, a binding of `RateLimiter`, and answers whether it
 * is within `limit` requests per `windowSeconds`.
 */
export async function rateLimit<Id>(
  namespace: DurableObjectNamespaceLike<Id, RateLimiterStub>,
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  assertRateLimitOptions(options);
  const { limit, windowSeconds } = options;
  return objectFor(namespace, key).consume({ limit, windowSeconds });
}

/** Forgets `key`'s count, such as after a sign-in that succeeded. */
export async function resetRateLimit<Id>(
  namespace: DurableObjectNamespaceLike<Id, RateLimiterStub>,
  key: string,
): Promise<void> {
  await objectFor(namespace, key).reset();
}
