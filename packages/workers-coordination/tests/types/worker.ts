/**
 * A Worker as an app writes one, type-checked (`pnpm run check`) against @cloudflare/workers-types:
 * the clients take the namespaces `wrangler types` declares, and refuse another class's.
 */
import {
  acquireLease,
  LeaseLostError,
  rateLimit,
  resetRateLimit,
} from "../../src/index.js";
import type {
  Lease,
  LeaseLock,
  RateLimiter,
  RateLimitResult,
} from "../../src/index.js";

export { LeaseLock, RateLimiter } from "../../src/index.js";

interface Env {
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  LOCKS: DurableObjectNamespace<LeaseLock>;
}

export default {
  async fetch(request, env) {
    const result: RateLimitResult = await rateLimit(
      env.RATE_LIMITER,
      "sign-in:account-1",
      {
        limit: 5,
        windowSeconds: 15 * 60,
      }
    );

    if (!result.allowed) {
      return new Response("Too many attempts", { status: 429 });
    }

    await resetRateLimit(env.RATE_LIMITER, "sign-in:account-1");

    const lease: Lease | null = await acquireLease(
      env.LOCKS,
      "provision:customer-1",
      {
        ttlMs: 60_000,
      }
    );

    if (!lease) {
      return new Response("Busy", { status: 409 });
    }

    try {
      await lease.renew();
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
    } finally {
      await lease.release();
    }

    // @ts-expect-error A LeaseLock namespace is not a RateLimiter's.
    await rateLimit(env.LOCKS, "key", { limit: 1, windowSeconds: 1 });
    // @ts-expect-error A RateLimiter namespace is not a LeaseLock's.
    await acquireLease(env.RATE_LIMITER, "key", { ttlMs: 1 });

    return new Response(null, { status: 204 });
  },
} satisfies ExportedHandler<Env>;
