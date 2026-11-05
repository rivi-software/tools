/**
 * The window arithmetic of `RateLimiter` at exact times, and the client's checks before it calls
 * the object. `workerd.test.ts` runs the object itself.
 */
import { describe, expect, it } from "vitest";
import {
  assertRateLimitOptions,
  countRequest,
  rateLimit,
  type RateLimitWindow,
  resetRateLimit,
} from "../src/rate-limit.js";

const options = { limit: 3, windowSeconds: 60 };
const start = 1_800_000_000_000;

/** Counts a request at each of `times`, from no window, and answers each result and the last window. */
function requests(times: number[], opts = options) {
  let window: RateLimitWindow | undefined;
  const results = times.map((now) => {
    const next = countRequest(window, opts, now);
    window = next.window;
    return next.result;
  });
  return { results, window };
}

describe("countRequest", () => {
  it("opens a window at a key's first request and allows `limit` requests in it", () => {
    const { results, window } = requests([start, start + 1000, start + 2000]);
    expect(results).toEqual([
      { allowed: true, remaining: 2, resetAt: start + 60_000 },
      { allowed: true, remaining: 1, resetAt: start + 60_000 },
      { allowed: true, remaining: 0, resetAt: start + 60_000 },
    ]);
    expect(window).toEqual({ count: 3, resetAt: start + 60_000 });
  });

  it("refuses past the limit until the window ends, and does not count a refusal", () => {
    const { results, window } = requests([start, start, start, start + 10, start + 59_999]);
    expect(results.slice(3)).toEqual([
      { allowed: false, remaining: 0, resetAt: start + 60_000 },
      { allowed: false, remaining: 0, resetAt: start + 60_000 },
    ]);
    expect(window).toEqual({ count: 3, resetAt: start + 60_000 });
  });

  it("opens the next window at the first request at or after the end", () => {
    const full = requests([start, start, start]).window;
    expect(countRequest(full, options, start + 60_000)).toEqual({
      window: { count: 1, resetAt: start + 120_000 },
      result: { allowed: true, remaining: 2, resetAt: start + 120_000 },
    });
    // A key idle for longer starts from its own first request, not on a grid.
    expect(countRequest(full, options, start + 95_000).window).toEqual({
      count: 1,
      resetAt: start + 155_000,
    });
  });

  it("returns the stored window itself when nothing changes, so the object writes nothing", () => {
    const full = requests([start, start, start]).window;
    expect(countRequest(full, options, start + 1).window).toBe(full);
  });

  it("keeps a window's end when windowSeconds changes, and applies a new limit at once", () => {
    const open = requests([start, start + 1]).window;
    expect(countRequest(open, { limit: 3, windowSeconds: 1 }, start + 5000).result).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: start + 60_000,
    });
    expect(countRequest(open, { limit: 2, windowSeconds: 60 }, start + 2).result).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: start + 60_000,
    });
  });

  it("keeps counting when the clock goes back, rather than opening a new window", () => {
    const open = requests([start]).window;
    expect(countRequest(open, options, start - 5000).window).toEqual({
      count: 2,
      resetAt: start + 60_000,
    });
  });

  it("rounds a window of a fraction of a millisecond up to whole milliseconds", () => {
    expect(countRequest(undefined, { limit: 1, windowSeconds: 0.0001 }, start).window).toEqual({
      count: 1,
      resetAt: start + 1,
    });
  });
});

describe("assertRateLimitOptions", () => {
  it.each([
    { limit: 0, windowSeconds: 60 },
    { limit: -1, windowSeconds: 60 },
    { limit: 1.5, windowSeconds: 60 },
    { limit: Number.NaN, windowSeconds: 60 },
    { limit: "5" as unknown as number, windowSeconds: 60 },
    { limit: 5, windowSeconds: 0 },
    { limit: 5, windowSeconds: -60 },
    { limit: 5, windowSeconds: Number.POSITIVE_INFINITY },
    { limit: 5, windowSeconds: "60" as unknown as number },
  ])("refuses %o", (bad) => {
    expect(() => assertRateLimitOptions(bad)).toThrow(RangeError);
  });

  it("takes a whole limit and any window above 0", () => {
    expect(() => assertRateLimitOptions({ limit: 1, windowSeconds: 0.5 })).not.toThrow();
    expect(() => assertRateLimitOptions({ limit: 10_000, windowSeconds: 86_400 })).not.toThrow();
  });
});

describe("rateLimit", () => {
  /** A namespace that records the names it is asked for and the calls its objects get. */
  function recordingNamespace() {
    const calls: unknown[][] = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        consume: async (opts: unknown) => {
          calls.push([id, "consume", opts]);
          return { allowed: true, remaining: 0, resetAt: 0 };
        },
        reset: async () => void calls.push([id, "reset"]),
      }),
    };
    return { namespace, calls };
  }

  it("calls the key's object with the limit and window alone", async () => {
    const { namespace, calls } = recordingNamespace();
    const extra = { limit: 2, windowSeconds: 30, onRefused: () => undefined };
    await rateLimit(namespace, "sign-in:account-1", extra);
    await resetRateLimit(namespace, "sign-in:account-2");
    // A function would not survive the call to a Durable Object, so it is not passed on.
    expect(calls).toEqual([
      ["sign-in:account-1", "consume", { limit: 2, windowSeconds: 30 }],
      ["sign-in:account-2", "reset"],
    ]);
  });

  it("refuses bad options and an empty key before it calls any object", async () => {
    const { namespace, calls } = recordingNamespace();
    await expect(rateLimit(namespace, "key", { limit: 0, windowSeconds: 60 })).rejects.toThrow(
      "limit must be a whole number, 1 or more, not 0",
    );
    await expect(rateLimit(namespace, "", options)).rejects.toThrow(TypeError);
    await expect(resetRateLimit(namespace, "")).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });
});
