/**
 * The lease arithmetic of `LeaseLock` at exact times, and the client's checks before it calls the
 * object. `workerd.test.ts` runs the object itself.
 */
import { describe, expect, it } from "vitest";
import {
  acquireLease,
  assertLeaseOptions,
  holds,
  LeaseLostError,
  renewLease,
  takeLease,
} from "../src/lease.js";

const start = 1_800_000_000_000;
const held = { token: "t1", expiresAt: start + 1000, ttlMs: 1000 };

describe("takeLease", () => {
  it("grants a free key for ttlMs from now", () => {
    expect(takeLease(undefined, 1000, start, "t1")).toEqual(held);
  });

  it("refuses while the lease runs, and grants it again from its expiresAt on", () => {
    expect(takeLease(held, 5000, start + 999, "t2")).toBeNull();
    expect(takeLease(held, 5000, start + 1000, "t2")).toEqual({
      token: "t2",
      expiresAt: start + 6000,
      ttlMs: 5000,
    });
  });
});

describe("renewLease and holds", () => {
  it("extends the holder's lease by its ttlMs from now", () => {
    expect(renewLease(held, "t1", start + 400)).toEqual({ ...held, expiresAt: start + 1400 });
  });

  it("refuses another token, an ended lease and a key with no lease", () => {
    expect(renewLease(held, "t2", start)).toBeNull();
    expect(renewLease(held, "t1", start + 1000)).toBeNull();
    expect(renewLease(undefined, "t1", start)).toBeNull();
  });

  it("holds only for the token, and only until expiresAt", () => {
    expect(holds(held, "t1", start + 999)).toBe(true);
    expect(holds(held, "t1", start + 1000)).toBe(false);
    expect(holds(held, "t2", start)).toBe(false);
    expect(holds(undefined, "t1", start)).toBe(false);
  });
});

describe("assertLeaseOptions", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60000" as unknown as number])(
    "refuses ttlMs %o",
    (ttlMs) => {
      expect(() => assertLeaseOptions({ ttlMs })).toThrow(RangeError);
    },
  );
});

describe("acquireLease", () => {
  /** A namespace whose one object answers as `answers` says, and records its calls. */
  function namespaceAnswering(answers: { acquire?: unknown; renew?: unknown; release?: unknown }) {
    const calls: unknown[][] = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        acquire: async (options: unknown) => (
          calls.push([id, "acquire", options]),
          answers.acquire
        ),
        renew: async (token: string) => (calls.push([id, "renew", token]), answers.renew),
        release: async (token: string) => (calls.push([id, "release", token]), answers.release),
      }),
    } as never;
    return { namespace, calls };
  }

  it("answers null while another holder has the key", async () => {
    const { namespace } = namespaceAnswering({ acquire: null });
    expect(await acquireLease(namespace, "provision:1", { ttlMs: 1000 })).toBeNull();
  });

  it("renews and releases with the lease's own token, and follows the new expiresAt", async () => {
    const answers = { acquire: { token: "t1", expiresAt: 1000 }, renew: 5000, release: true };
    const { namespace, calls } = namespaceAnswering(answers);
    const lease = await acquireLease(namespace, "provision:1", { ttlMs: 1000 });
    expect(lease).toMatchObject({ key: "provision:1", token: "t1", expiresAt: 1000 });
    await lease!.renew();
    expect(lease!.expiresAt).toBe(5000);
    expect(await lease!.release()).toBe(true);
    expect(calls).toEqual([
      ["provision:1", "acquire", { ttlMs: 1000 }],
      ["provision:1", "renew", "t1"],
      ["provision:1", "release", "t1"],
    ]);
  });

  it("throws a LeaseLostError from renew when the lease has ended", async () => {
    const answers = { acquire: { token: "t1", expiresAt: 1000 }, renew: null };
    const lease = await acquireLease(namespaceAnswering(answers).namespace, "provision:1", {
      ttlMs: 1000,
    });
    const error = await lease!.renew().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(LeaseLostError);
    expect(error).toMatchObject({ name: "LeaseLostError", key: "provision:1" });
    expect(lease!.expiresAt).toBe(1000);
  });

  it("refuses a bad ttlMs and an empty key before it calls any object", async () => {
    const { namespace, calls } = namespaceAnswering({});
    await expect(acquireLease(namespace, "key", { ttlMs: 0 })).rejects.toThrow(RangeError);
    await expect(acquireLease(namespace, "", { ttlMs: 1000 })).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });
});
