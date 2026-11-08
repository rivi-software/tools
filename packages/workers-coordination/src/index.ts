/**
 * Two Durable Objects for Cloudflare Workers, each with a typed client. `RateLimiter` and
 * `rateLimit()` count each key's requests in a fixed window of any length, with one count for the
 * key wherever its requests come from. `LeaseLock` and `acquireLease()` let one caller hold a key
 * at a time, until it releases the key or its lease expires.
 */
export {
  RateLimiter,
  rateLimit,
  resetRateLimit,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimiterStub,
} from "./rate-limit.js";

export { LeaseLostError } from "./lease-lost-error.js";

export {
  LeaseLock,
  acquireLease,
  type Lease,
  type LeaseGrant,
  type LeaseLockStub,
  type LeaseOptions,
} from "./lease.js";

export type { DurableObjectNamespaceLike } from "./objects.js";
