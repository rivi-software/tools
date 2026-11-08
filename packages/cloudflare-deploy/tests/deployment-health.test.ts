import { afterEach, describe, expect, it } from "vitest";

import { checkDeploymentHealth } from "../src/index.js";

const originalFetch = globalThis.fetch;

const mockFetch = (handler: (url: string) => Response | Error) => {
  const calls: string[] = [];
  // SAFETY: the health check only ever calls fetch with a URL string and an init
  globalThis.fetch =
    // oxlint-disable-next-line eslint/require-await -- a fetch answers a promise even when this fake needs nothing from one
    (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const result = handler(url);

      if (result instanceof Error) {
        throw result;
      }

      return result;
    }) as typeof fetch;

  return calls;
};

describe(checkDeploymentHealth, () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes on the first 2xx response and runs the validator", async () => {
    const calls = mockFetch(() => new Response("{}", { status: 200 }));
    let validated = false;
    await checkDeploymentHealth("https://example.test/", {
      paths: ["/api/v1/health"],
      validate: () => {
        validated = true;
      },
    });
    expect(calls).toStrictEqual(["https://example.test/api/v1/health"]);
    expect(validated).toBeTruthy();
  });

  it("retries transient statuses and tries every path per attempt", async () => {
    let count = 0;

    const calls = mockFetch(() => {
      count += 1;

      return new Response("", { status: count < 3 ? 503 : 200 });
    });

    await checkDeploymentHealth("https://example.test", {
      paths: ["/", "/docs"],
      delayMs: 0,
    });
    expect(calls).toStrictEqual([
      "https://example.test/",
      "https://example.test/docs",
      "https://example.test/",
    ]);
  });

  it("fails at once on a non-transient status", async () => {
    const calls = mockFetch(() => new Response("", { status: 401 }));
    await expect(
      checkDeploymentHealth("https://example.test", { delayMs: 0 })
    ).rejects.toThrow("HTTP 401");
    expect(calls).toHaveLength(1);
  });

  it("by default keeps retrying through a production rollout before giving up", async () => {
    // The previous version kept answering a custom domain for 17 s after `wrangler deploy`.
    const calls = mockFetch(() => new Response("", { status: 500 }));
    let slept = 0;
    await expect(
      checkDeploymentHealth("https://example.test", {
        sleep: (ms) => {
          slept += ms;

          return Promise.resolve();
        },
      })
    ).rejects.toThrow("HTTP 500");
    expect(slept).toBeGreaterThanOrEqual(60_000);
    expect(calls).toHaveLength(16);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    mockFetch(() => new Error("connect ECONNREFUSED"));
    await expect(
      checkDeploymentHealth("https://example.test", { attempts: 2, delayMs: 0 })
    ).rejects.toThrow("ECONNREFUSED");
  });
});
