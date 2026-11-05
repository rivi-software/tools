// The Worker that workerd.test.ts runs, beside the package as `pnpm run build` emits it. It exports
// the classes the way an app does, each with one more method that shows what the object keeps, and
// runs the clients in workerd, one command per request. The classes keep their own helpers in
// #private methods, so `stored()` here overrides nothing and RPC reaches none of them.
import {
  acquireLease,
  LeaseLock,
  LeaseLostError,
  rateLimit,
  RateLimiter,
  resetRateLimit,
} from "./index.js";

/** An object's storage: every key-value entry, and the alarm's time or null. */
async function stored(storage) {
  return { entries: Object.fromEntries(storage.kv.list()), alarm: await storage.getAlarm() };
}

export class TestRateLimiter extends RateLimiter {
  async stored() {
    return stored(this.ctx.storage);
  }
}

export class TestLeaseLock extends LeaseLock {
  async stored() {
    return stored(this.ctx.storage);
  }
}

// The leases this isolate took, by token, so a later request can renew or release one.
const leases = new Map();

const commands = {
  rateLimit: (env, { key, limit, windowSeconds }) =>
    rateLimit(env.RATE_LIMITER, key, { limit, windowSeconds }),
  resetRateLimit: (env, { key }) => resetRateLimit(env.RATE_LIMITER, key).then(() => null),
  async acquireLease(env, { key, ttlMs }) {
    const lease = await acquireLease(env.LOCKS, key, { ttlMs });
    if (!lease) return null;
    leases.set(lease.token, lease);
    return { token: lease.token, expiresAt: lease.expiresAt };
  },
  async renewLease(env, { token }) {
    const lease = leases.get(token);
    try {
      await lease.renew();
      return { expiresAt: lease.expiresAt };
    } catch (error) {
      if (error instanceof LeaseLostError) return { lost: error.key };
      throw error;
    }
  },
  releaseLease: (env, { token }) => leases.get(token).release(),
  stored(env, { binding, key }) {
    const namespace = env[binding];
    return namespace.get(namespace.idFromName(key)).stored();
  },
};

export default {
  async fetch(request, env) {
    const { command, ...args } = await request.json();
    return Response.json(await commands[command](env, args));
  },
};
