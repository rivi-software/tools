/**
 * The built package in workerd (Miniflare): the clients call the objects over Durable Object RPC,
 * the objects keep their state in SQLite-backed storage, and their alarms run at real times.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Grant, startWorker } from "./workerd.js";

type Worker = Awaited<ReturnType<typeof startWorker>>;

const empty = { entries: {}, alarm: null };
/** Long enough for an alarm to run after a short window or lease ends, on a busy CI machine too. */
const settles = { timeout: 10_000, interval: 50 };

let worker: Worker;
beforeAll(async () => {
  worker = await startWorker();
}, 60_000);
afterAll(() => worker?.dispose());

describe("RateLimiter", () => {
  it("counts simultaneous requests for a key one after the other", async () => {
    const key = `sign-in:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => worker.rateLimit(key, { limit: 3, windowSeconds: 60 })),
    );
    const allowed = results.filter((result) => result.allowed);
    expect(allowed.map((result) => result.remaining).sort()).toEqual([0, 1, 2]);
    expect(results.filter((result) => !result.allowed)).toHaveLength(7);
    expect(results.filter((result) => !result.allowed).every((r) => r.remaining === 0)).toBe(true);
    expect(new Set(results.map((result) => result.resetAt)).size).toBe(1);
    // Every key has its own object and count.
    expect(
      await worker.rateLimit(`sign-in:${randomUUID()}`, { limit: 3, windowSeconds: 60 }),
    ).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("keeps one window with an alarm at its end, and nothing once the window has ended", async () => {
    const key = `sign-in:${randomUUID()}`;
    const first = await worker.rateLimit(key, { limit: 2, windowSeconds: 0.3 });
    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    expect(await worker.stored("RATE_LIMITER", key)).toEqual({
      entries: { window: { count: 1, resetAt: first.resetAt } },
      alarm: first.resetAt,
    });
    await vi.waitFor(
      async () => expect(await worker.stored("RATE_LIMITER", key)).toEqual(empty),
      settles,
    );
    expect(await worker.rateLimit(key, { limit: 2, windowSeconds: 60 })).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("forgets a key's count and alarm on resetRateLimit", async () => {
    const key = `account-password:${randomUUID()}`;
    const options = { limit: 1, windowSeconds: 600 };
    expect((await worker.rateLimit(key, options)).allowed).toBe(true);
    expect((await worker.rateLimit(key, options)).allowed).toBe(false);
    await worker.resetRateLimit(key);
    expect(await worker.stored("RATE_LIMITER", key)).toEqual(empty);
    expect((await worker.rateLimit(key, options)).allowed).toBe(true);
  });
});

describe("LeaseLock", () => {
  it("grants one lease at a time, however many callers ask at once", async () => {
    const key = `provision:${randomUUID()}`;
    const grants = await Promise.all(
      Array.from({ length: 10 }, () => worker.acquireLease(key, 60_000)),
    );
    const granted = grants.filter((grant): grant is Grant => grant !== null);
    expect(granted).toHaveLength(1);
    const [lease] = granted;
    expect(await worker.stored("LOCKS", key)).toEqual({
      entries: { lease: { token: lease.token, expiresAt: lease.expiresAt, ttlMs: 60_000 } },
      alarm: lease.expiresAt,
    });
    // Another key is another lock.
    expect(await worker.acquireLease(`provision:${randomUUID()}`, 60_000)).not.toBeNull();

    expect(await worker.releaseLease(lease.token)).toBe(true);
    expect(await worker.stored("LOCKS", key)).toEqual(empty);
    expect(await worker.acquireLease(key, 60_000)).not.toBeNull();
  });

  it("renews only while the lease runs", async () => {
    const key = `backfill:${randomUUID()}`;
    const lease = (await worker.acquireLease(key, 60_000))!;
    await sleep(20);
    const renewed = await worker.renewLease(lease.token);
    expect(renewed).toEqual({ expiresAt: expect.any(Number) });
    const { expiresAt } = renewed as { expiresAt: number };
    expect(expiresAt).toBeGreaterThan(lease.expiresAt);
    expect((await worker.stored("LOCKS", key)).alarm).toBe(expiresAt);

    expect(await worker.releaseLease(lease.token)).toBe(true);
    expect(await worker.renewLease(lease.token)).toEqual({ lost: key });
    expect(await worker.releaseLease(lease.token)).toBe(false);
  });

  it("frees the key of a holder that never released, which then cannot end the next lease", async () => {
    const key = `provision:${randomUUID()}`;
    const crashed = (await worker.acquireLease(key, 300))!;
    expect(await worker.acquireLease(key, 60_000)).toBeNull();
    await vi.waitFor(async () => expect(await worker.stored("LOCKS", key)).toEqual(empty), settles);

    const next = (await worker.acquireLease(key, 60_000))!;
    expect(next).not.toBeNull();
    expect(await worker.releaseLease(crashed.token)).toBe(false);
    expect(await worker.renewLease(crashed.token)).toEqual({ lost: key });
    expect(await worker.acquireLease(key, 60_000)).toBeNull();
    expect(await worker.releaseLease(next.token)).toBe(true);
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
    expect(await old.stored("RATE_LIMITER", key)).toEqual(empty);

    const lease = (await old.acquireLease(key, 60_000))!;
    expect(await old.releaseLease(lease.token)).toBe(true);
    expect(await old.stored("LOCKS", key)).toEqual(empty);
  });
});
