/**
 * The lease arithmetic of `LeaseLock` at exact times, and the client's checks before it calls the
 * object. `workerd.test.ts` runs the object itself.
 */
import { describe, expect, it } from "vitest";

import { LeaseLostError } from "../src/lease-lost-error.js";
import {
  acquireLease,
  assertLeaseOptions,
  holds,
  renewLease,
  takeLease,
} from "../src/lease.js";
import type { LeaseGrant, LeaseOptions } from "../src/lease.js";

const start = 1_800_000_000_000;
const held = { token: "t1", expiresAt: start + 1000, ttlMs: 1000 };

/** What the object behind the stub answers to each of the three calls the client makes. */
interface Answers {
  acquire?: LeaseGrant | null;
  renew?: number | null;
  release?: boolean;
}

/** A namespace whose one object answers as `answers` says, and records its calls. */
const namespaceAnswering = (answers: Answers) => {
  const calls: unknown[][] = [];

  const answer = <T>(
    id: string,
    method: string,
    argument: LeaseOptions | string,
    value: T
  ) => {
    calls.push([id, method, argument]);

    return Promise.resolve(value);
  };

  // SAFETY: the stub has the three methods `acquireLease` calls through a namespace, and the test
  // only ever passes it to `acquireLease`.
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      acquire: (options: LeaseOptions) =>
        answer(id, "acquire", options, answers.acquire),
      renew: (token: string) => answer(id, "renew", token, answers.renew),
      release: (token: string) => answer(id, "release", token, answers.release),
    }),
  } as never;

  return { namespace, calls };
};

/** The lease `acquireLease` granted, or an error naming the test that expected one. */
const granted = (lease: Awaited<ReturnType<typeof acquireLease>>) => {
  if (!lease) {
    throw new Error("Expected acquireLease to grant a lease");
  }

  return lease;
};

describe(takeLease, () => {
  it("grants a free key for ttlMs from now", () => {
    expect(takeLease(undefined, 1000, start, "t1")).toStrictEqual(held);
  });

  it("refuses while the lease runs, and grants it again from its expiresAt on", () => {
    expect(takeLease(held, 5000, start + 999, "t2")).toBeNull();
    expect(takeLease(held, 5000, start + 1000, "t2")).toStrictEqual({
      token: "t2",
      expiresAt: start + 6000,
      ttlMs: 5000,
    });
  });
});

describe("renewLease and holds", () => {
  it("extends the holder's lease by its ttlMs from now", () => {
    expect(renewLease(held, "t1", start + 400)).toStrictEqual({
      ...held,
      expiresAt: start + 1400,
    });
  });

  it("refuses another token, an ended lease and a key with no lease", () => {
    expect(renewLease(held, "t2", start)).toBeNull();
    expect(renewLease(held, "t1", start + 1000)).toBeNull();
    expect(renewLease(undefined, "t1", start)).toBeNull();
  });

  it("holds only for the token, and only until expiresAt", () => {
    expect(holds(held, "t1", start + 999)).toBeTruthy();
    expect(holds(held, "t1", start + 1000)).toBeFalsy();
    expect(holds(held, "t2", start)).toBeFalsy();
    expect(holds(undefined, "t1", start)).toBeFalsy();
  });
});

describe(assertLeaseOptions, () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses ttlMs %o",
    (ttlMs) => {
      expect(() => assertLeaseOptions({ ttlMs })).toThrow(RangeError);
    }
  );

  it("refuses a ttlMs that is not a number", () => {
    // SAFETY: JSON stands in for a JavaScript caller, which can pass anything; this case checks
    // that a string ttlMs is refused.
    const fromJavaScript = JSON.parse('{ "ttlMs": "60000" }') as LeaseOptions;

    expect(() => assertLeaseOptions(fromJavaScript)).toThrow(RangeError);
  });
});

describe(acquireLease, () => {
  it("answers null while another holder has the key", async () => {
    const { namespace } = namespaceAnswering({ acquire: null });

    await expect(
      acquireLease(namespace, "provision:1", { ttlMs: 1000 })
    ).resolves.toBeNull();
  });

  it("renews and releases with the lease's own token, and follows the new expiresAt", async () => {
    const answers = {
      acquire: { token: "t1", expiresAt: 1000 },
      renew: 5000,
      release: true,
    };

    const { namespace, calls } = namespaceAnswering(answers);

    const lease = granted(
      await acquireLease(namespace, "provision:1", { ttlMs: 1000 })
    );

    expect(lease).toMatchObject({
      key: "provision:1",
      token: "t1",
      expiresAt: 1000,
    });
    await lease.renew();
    expect(lease.expiresAt).toBe(5000);
    await expect(lease.release()).resolves.toBeTruthy();
    expect(calls).toStrictEqual([
      ["provision:1", "acquire", { ttlMs: 1000 }],
      ["provision:1", "renew", "t1"],
      ["provision:1", "release", "t1"],
    ]);
  });

  it("throws a LeaseLostError from renew when the lease has ended", async () => {
    const answers = { acquire: { token: "t1", expiresAt: 1000 }, renew: null };

    const lease = granted(
      await acquireLease(namespaceAnswering(answers).namespace, "provision:1", {
        ttlMs: 1000,
      })
    );

    const renewal = lease.renew();

    await expect(renewal).rejects.toBeInstanceOf(LeaseLostError);
    await expect(renewal).rejects.toMatchObject({
      name: "LeaseLostError",
      key: "provision:1",
    });
    expect(lease.expiresAt).toBe(1000);
  });

  it("refuses a bad ttlMs and an empty key before it calls any object", async () => {
    const { namespace, calls } = namespaceAnswering({});

    await expect(acquireLease(namespace, "key", { ttlMs: 0 })).rejects.toThrow(
      RangeError
    );
    await expect(acquireLease(namespace, "", { ttlMs: 1000 })).rejects.toThrow(
      TypeError
    );
    expect(calls).toStrictEqual([]);
  });
});
