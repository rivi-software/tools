/**
 * `LeaseLock`, a Durable Object that grants one lease for its key at a time, and
 * `acquireLease()`, its client. A lease ends at its expiry unless its holder renews it, so a
 * holder that crashed frees the key on its own. Only the holder's token renews or releases it, so
 * a holder whose lease expired cannot end the next holder's.
 */
import { DurableObject } from "cloudflare:workers";

import { LeaseLostError } from "./lease-lost-error.js";
import { forget, objectFor } from "./objects.js";
import type { DurableObjectNamespaceLike } from "./objects.js";

/** How long a lease lasts. */
export interface LeaseOptions {
  /** How long the lease lasts, in milliseconds, from when it is taken and again from each renewal. */
  readonly ttlMs: number;
}

/** A lease a `LeaseLock` granted: the token that renews and releases it, and when it ends. */
export interface LeaseGrant {
  /** The token that renews and releases the lease. */
  readonly token: string;
  /** When the lease ends unless it is renewed, in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** A key's lease, as its `LeaseLock` stores it. */
export interface StoredLease {
  /** The holder's token. */
  readonly token: string;
  /** When the lease ends unless it is renewed, in milliseconds since the epoch. */
  readonly expiresAt: number;
  /** How far each renewal moves `expiresAt` on from the time of the renewal. */
  readonly ttlMs: number;
}

/** The methods of a `LeaseLock` stub that the client calls. */
export interface LeaseLockStub {
  /** Grants the lease, or null while another holder has it (`LeaseLock.acquire`). */
  acquire: (options: LeaseOptions) => Promise<LeaseGrant | null>;
  /** The lease's new `expiresAt`, or null when it has ended (`LeaseLock.renew`). */
  renew: (token: string) => Promise<number | null>;
  /** Ends the lease; false when it had already ended (`LeaseLock.release`). */
  release: (token: string) => Promise<boolean>;
}

/** A lease `acquireLease()` took. */
export interface Lease {
  /** The key the lease is for. */
  readonly key: string;
  /** The lease's token, which only this holder has. */
  readonly token: string;
  /** When the lease ends unless it is renewed, in milliseconds since the epoch. */
  readonly expiresAt: number;
  /**
   * Extends the lease by its `ttlMs` from now. Throws a `LeaseLostError` when the lease has
   * already ended: it expired, or it was released.
   */
  renew: () => Promise<void>;
  /** Ends the lease. False when it had already ended, which leaves the key as it is. */
  release: () => Promise<boolean>;
}

/** Throws a `RangeError` for a `ttlMs` that is not a whole number of milliseconds above 0. */
export const assertLeaseOptions = (options: LeaseOptions): void => {
  const { ttlMs } = options ?? {};

  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError(
      `ttlMs must be a whole number of milliseconds, 1 or more, not ${ttlMs}`
    );
  }
};

/** Whether `token` holds `lease` at `now`. A lease has ended at its `expiresAt`. */
export const holds = (
  lease: StoredLease | undefined,
  token: string,
  now: number
): boolean =>
  lease !== undefined && lease.token === token && lease.expiresAt > now;

/** The new lease for `token` when `current` is free or has ended at `now`; null while it is held. */
export const takeLease = (
  current: StoredLease | undefined,
  ttlMs: number,
  now: number,
  token: string
): StoredLease | null => {
  if (current && current.expiresAt > now) {
    return null;
  }

  return { token, expiresAt: now + ttlMs, ttlMs };
};

/** `current` extended by its `ttlMs` from `now` when `token` holds it; null when it does not. */
export const renewLease = (
  current: StoredLease | undefined,
  token: string,
  now: number
): StoredLease | null => {
  if (!current || !holds(current, token, now)) {
    return null;
  }

  return { ...current, expiresAt: now + current.ttlMs };
};

const LEASE = "lease";

/**
 * The Durable Object behind `acquireLease()`: one object for each key. A Worker exports it and
 * binds it ([README](https://github.com/rivi-software/tools/tree/main/packages/workers-coordination#readme)).
 */
export class LeaseLock extends DurableObject<unknown> {
  /** Grants the lease when it is free or has ended; null while another holder has it. */
  async acquire(options: LeaseOptions): Promise<LeaseGrant | null> {
    assertLeaseOptions(options);

    const lease = takeLease(
      this.#stored(),
      options.ttlMs,
      Date.now(),
      crypto.randomUUID()
    );

    if (!lease) {
      return null;
    }

    await this.#store(lease);

    return { token: lease.token, expiresAt: lease.expiresAt };
  }

  /** The lease's new `expiresAt` when `token` holds it; null when it has ended. */
  async renew(token: string): Promise<number | null> {
    const lease = renewLease(this.#stored(), token, Date.now());

    if (!lease) {
      return null;
    }

    await this.#store(lease);

    return lease.expiresAt;
  }

  /** Ends the lease when `token` holds it; false when it has already ended. */
  async release(token: string): Promise<boolean> {
    if (!holds(this.#stored(), token, Date.now())) {
      return false;
    }

    await forget(this.ctx.storage);

    return true;
  }

  /** The lease has ended: the object keeps nothing for a key nobody holds. */
  async alarm(): Promise<void> {
    const lease = this.#stored();

    await (lease && lease.expiresAt > Date.now()
      ? this.ctx.storage.setAlarm(lease.expiresAt)
      : forget(this.ctx.storage));
  }

  #stored(): StoredLease | undefined {
    return this.ctx.storage.kv.get<StoredLease>(LEASE);
  }

  async #store(lease: StoredLease): Promise<void> {
    this.ctx.storage.kv.put(LEASE, lease);
    await this.ctx.storage.setAlarm(lease.expiresAt);
  }
}

/**
 * Takes the lease on `key` in `namespace`, a binding of `LeaseLock`, for `ttlMs`. Null while
 * another holder has it.
 */
export const acquireLease = async <Id>(
  namespace: DurableObjectNamespaceLike<Id, LeaseLockStub>,
  key: string,
  options: LeaseOptions
): Promise<Lease | null> => {
  assertLeaseOptions(options);

  const grant = await objectFor(namespace, key).acquire({
    ttlMs: options.ttlMs,
  });

  if (!grant) {
    return null;
  }

  const { token } = grant;
  let { expiresAt } = grant;

  return {
    key,
    token,
    get expiresAt() {
      return expiresAt;
    },
    async renew() {
      const renewed = await objectFor(namespace, key).renew(token);

      if (renewed === null) {
        throw new LeaseLostError(key);
      }

      expiresAt = renewed;
    },
    release: () => objectFor(namespace, key).release(token),
  };
};
