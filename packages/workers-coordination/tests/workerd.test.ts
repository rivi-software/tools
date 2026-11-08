/**
 * The built package in workerd (Miniflare): the clients call the objects over Durable Object RPC,
 * the objects keep their state in SQLite-backed storage, and their alarms run at real times.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startWorker } from "./workerd.js";
import type { Grant } from "./workerd.js";

type Worker = Awaited<ReturnType<typeof startWorker>>;

const empty = { entries: {}, alarm: null };

/** Long enough for an alarm to run after a short window or lease ends, on a busy CI machine too. */
const settles = { timeout: 10_000, interval: 50 };

/** The grant the lock gave, or an error naming what the test expected. */
const granted = (grant: Grant | null): Grant => {
  if (!grant) {
    throw new Error("Expected acquireLease to grant a lease");
  }

  return grant;
};

describe("the built package in workerd", () => {
  let worker: Worker;

  beforeAll(async () => {
    worker = await startWorker();
  }, 60_000);

  afterAll(() => worker?.dispose());

  describe("RateLimiter", () => {
    it("counts simultaneous requests for a key one after the other", async () => {
      const key = `sign-in:${randomUUID()}`;

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          worker.rateLimit(key, { limit: 3, windowSeconds: 60 })
        )
      );

      const allowed = results.filter((result) => result.allowed);
      const refused = results.filter((result) => !result.allowed);

      expect(
        allowed.map((result) => result.remaining).toSorted()
      ).toStrictEqual([0, 1, 2]);
      expect(refused).toHaveLength(7);
      expect(refused.every((result) => result.remaining === 0)).toBeTruthy();
      expect(new Set(results.map((result) => result.resetAt)).size).toBe(1);
      // Every key has its own object and count.
      await expect(
        worker.rateLimit(`sign-in:${randomUUID()}`, {
          limit: 3,
          windowSeconds: 60,
        })
      ).resolves.toMatchObject({ allowed: true, remaining: 2 });
    });

    it("keeps one window with an alarm at its end, and nothing once the window has ended", async () => {
      const key = `sign-in:${randomUUID()}`;

      const first = await worker.rateLimit(key, {
        limit: 2,
        windowSeconds: 0.3,
      });

      expect(first).toMatchObject({ allowed: true, remaining: 1 });
      await expect(worker.stored("RATE_LIMITER", key)).resolves.toStrictEqual({
        entries: { window: { count: 1, resetAt: first.resetAt } },
        alarm: first.resetAt,
      });
      await vi.waitFor(
        async () =>
          await expect(
            worker.stored("RATE_LIMITER", key)
          ).resolves.toStrictEqual(empty),
        settles
      );
      await expect(
        worker.rateLimit(key, { limit: 2, windowSeconds: 60 })
      ).resolves.toMatchObject({
        allowed: true,
        remaining: 1,
      });
    });

    it("forgets a key's count and alarm on resetRateLimit", async () => {
      const key = `account-password:${randomUUID()}`;
      const options = { limit: 1, windowSeconds: 600 };
      const first = await worker.rateLimit(key, options);
      const second = await worker.rateLimit(key, options);

      expect(first.allowed).toBeTruthy();
      expect(second.allowed).toBeFalsy();
      await worker.resetRateLimit(key);
      await expect(worker.stored("RATE_LIMITER", key)).resolves.toStrictEqual(
        empty
      );

      const afterReset = await worker.rateLimit(key, options);

      expect(afterReset.allowed).toBeTruthy();
    });
  });

  describe("LeaseLock", () => {
    it("grants one lease at a time, however many callers ask at once", async () => {
      const key = `provision:${randomUUID()}`;

      const grants = await Promise.all(
        Array.from({ length: 10 }, () => worker.acquireLease(key, 60_000))
      );

      const held = grants.filter((grant): grant is Grant => grant !== null);

      expect(held).toHaveLength(1);

      const [lease] = held;

      await expect(worker.stored("LOCKS", key)).resolves.toStrictEqual({
        entries: {
          lease: {
            token: lease.token,
            expiresAt: lease.expiresAt,
            ttlMs: 60_000,
          },
        },
        alarm: lease.expiresAt,
      });
      await expect(worker.releaseLease(lease.token)).resolves.toBeTruthy();
      await expect(worker.stored("LOCKS", key)).resolves.toStrictEqual(empty);
      await expect(worker.acquireLease(key, 60_000)).resolves.not.toBeNull();
    });

    it("gives another key its own lock", async () => {
      const key = `provision:${randomUUID()}`;

      await worker.acquireLease(key, 60_000);
      await expect(
        worker.acquireLease(`provision:${randomUUID()}`, 60_000)
      ).resolves.not.toBeNull();
    });

    it("renews a lease that is running, and moves its alarm on", async () => {
      const key = `backfill:${randomUUID()}`;
      const lease = granted(await worker.acquireLease(key, 60_000));

      await sleep(20);

      const renewed = await worker.renewLease(lease.token);

      expect(renewed).toStrictEqual({ expiresAt: expect.any(Number) });

      if (!("expiresAt" in renewed)) {
        throw new Error("Expected renewLease to answer a new expiresAt");
      }

      expect(renewed.expiresAt).toBeGreaterThan(lease.expiresAt);

      const stored = await worker.stored("LOCKS", key);

      expect(stored.alarm).toBe(renewed.expiresAt);
    });

    it("stops renewing and releasing once the lease is released", async () => {
      const key = `backfill:${randomUUID()}`;
      const lease = granted(await worker.acquireLease(key, 60_000));

      await expect(worker.releaseLease(lease.token)).resolves.toBeTruthy();
      await expect(worker.renewLease(lease.token)).resolves.toStrictEqual({
        lost: key,
      });
      await expect(worker.releaseLease(lease.token)).resolves.toBeFalsy();
    });

    it("frees the key of a holder that never released", async () => {
      const key = `provision:${randomUUID()}`;

      await worker.acquireLease(key, 300);
      await expect(worker.acquireLease(key, 60_000)).resolves.toBeNull();
      await vi.waitFor(
        async () =>
          await expect(worker.stored("LOCKS", key)).resolves.toStrictEqual(
            empty
          ),
        settles
      );
      await expect(worker.acquireLease(key, 60_000)).resolves.not.toBeNull();
    });

    it("keeps a holder whose lease expired from ending the next one", async () => {
      const key = `provision:${randomUUID()}`;
      const crashed = granted(await worker.acquireLease(key, 300));

      await vi.waitFor(
        async () =>
          await expect(worker.stored("LOCKS", key)).resolves.toStrictEqual(
            empty
          ),
        settles
      );

      const next = granted(await worker.acquireLease(key, 60_000));

      await expect(worker.releaseLease(crashed.token)).resolves.toBeFalsy();
      await expect(worker.renewLease(crashed.token)).resolves.toStrictEqual({
        lost: key,
      });
      await expect(worker.acquireLease(key, 60_000)).resolves.toBeNull();
      await expect(worker.releaseLease(next.token)).resolves.toBeTruthy();
    });
  });

  describe("before compatibility date 2026-02-24, when deleteAll() leaves the alarm", () => {
    let old: Worker;

    beforeAll(async () => {
      old = await startWorker("2026-01-15");
    }, 60_000);

    afterAll(() => old?.dispose());

    it("deletes the alarm with the storage", async () => {
      const key = `sign-in:${randomUUID()}`;

      await old.rateLimit(key, { limit: 1, windowSeconds: 600 });
      await old.resetRateLimit(key);
      await expect(old.stored("RATE_LIMITER", key)).resolves.toStrictEqual(
        empty
      );

      const lease = granted(await old.acquireLease(key, 60_000));

      await expect(old.releaseLease(lease.token)).resolves.toBeTruthy();
      await expect(old.stored("LOCKS", key)).resolves.toStrictEqual(empty);
    });
  });
});
