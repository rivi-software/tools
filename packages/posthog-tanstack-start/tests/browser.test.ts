// @vitest-environment happy-dom
import { setTimeout as sleep } from "node:timers/promises";

import type { PostHog } from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// posthog-js as the browser loads it: its chunk fails to load until a test sets `loads`.
const posthog: Pick<PostHog, "init" | "captureException"> = {
  init: vi.fn<PostHog["init"]>(),
  captureException: vi.fn<PostHog["captureException"]>(),
};

const chunk = { loads: false, imports: 0, posthog };

const config = { token: "phc_test", host: "https://us.i.posthog.com" };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node passes the rejection's reason, whatever was thrown
const unhandled: unknown[] = [];

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node passes the rejection's reason, whatever was thrown
const onUnhandledRejection = (reason: unknown) => {
  unhandled.push(reason);
};

describe("posthog-js that does not load or start", () => {
  beforeEach(() => {
    // Each test starts from a page that has not loaded posthog-js yet: `resetModules` alone keeps a mock that loaded.
    vi.resetModules();
    chunk.loads = false;
    chunk.imports = 0;
    // oxlint-disable-next-line anti-slop/no-module-mocking -- `initPostHog` imports posthog-js itself, and taking a loader would change the published signature
    vi.doMock(import("posthog-js"), () => {
      chunk.imports += 1;

      if (!chunk.loads) {
        throw new TypeError(
          "Failed to fetch dynamically imported module: /assets/posthog.js"
        );
      }

      // SAFETY: `initPostHog` calls `init` and the tests call `captureException`; nothing reads the rest of the SDK.
      return { posthog: chunk.posthog as PostHog };
    });
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandled.length = 0;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("warns once and leaves PostHog off, with no unhandled rejection", async () => {
    const { captureClientException, initPostHog, withPostHog } =
      await import("../src/browser.js");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callback = vi.fn<(posthog: PostHog) => void>();

    initPostHog(config, {});
    withPostHog(callback);
    captureClientException(new Error("while loading"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    withPostHog(callback);
    captureClientException(new Error("after the failure"));
    // Node reports a rejection nothing handled once the task it happened in ends.
    await sleep(0);

    expect(unhandled).toStrictEqual([]);
    expect(callback).not.toHaveBeenCalled();
    expect(chunk.imports).toBe(1);
  });

  it("imports posthog-js again on the next initPostHog", async () => {
    const { captureClientException, initPostHog, withPostHog } =
      await import("../src/browser.js");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callback = vi.fn<(posthog: PostHog) => void>();

    initPostHog(config, {});
    captureClientException(new Error("while loading"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    chunk.loads = true;
    initPostHog(config, { person_profiles: "identified_only" });
    withPostHog(callback);
    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledExactlyOnceWith(chunk.posthog)
    );

    expect(chunk.imports).toBe(2);
    expect(chunk.posthog.init).toHaveBeenCalledExactlyOnceWith(
      "phc_test",
      expect.objectContaining({
        api_host: "https://us.i.posthog.com",
        person_profiles: "identified_only",
      })
    );
    // The exception from before the failure stays dropped: it is not sent once a later load succeeds.
    expect(chunk.posthog.captureException).not.toHaveBeenCalled();
  });

  it("leaves PostHog off for the page when posthog-js throws as it starts", async () => {
    const { initPostHog, withPostHog } = await import("../src/browser.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callback = vi.fn<(posthog: PostHog) => void>();
    chunk.loads = true;
    vi.mocked(chunk.posthog.init).mockImplementationOnce(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });

    initPostHog(config, {});
    withPostHog(callback);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    // posthog-js counts itself started before it throws, so a second `init` would hand back the half-started SDK.
    initPostHog(config, {});
    withPostHog(callback);
    await sleep(0);

    expect(unhandled).toStrictEqual([]);
    expect(callback).not.toHaveBeenCalled();
    expect(chunk.imports).toBe(1);
    expect(chunk.posthog.init).toHaveBeenCalledOnce();
  });
});
