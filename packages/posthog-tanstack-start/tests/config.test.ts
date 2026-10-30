import { describe, expect, it } from "vitest";
import { DEFAULT_HOST, posthogBrowserConfig } from "../src/config.js";

describe("posthogBrowserConfig", () => {
  it("turns PostHog off without a project token", () => {
    expect(posthogBrowserConfig({})).toBeNull();
    expect(
      posthogBrowserConfig({ POSTHOG_PROJECT_TOKEN: "", POSTHOG_HOST: "https://x" }),
    ).toBeNull();
  });

  it("sends to US Cloud, PostHog's own default, unless POSTHOG_HOST names another host", () => {
    expect(DEFAULT_HOST).toBe("https://us.i.posthog.com");
    expect(posthogBrowserConfig({ POSTHOG_PROJECT_TOKEN: "phc_1" })).toEqual({
      token: "phc_1",
      host: "https://us.i.posthog.com",
    });
    expect(posthogBrowserConfig({ POSTHOG_PROJECT_TOKEN: "phc_1", POSTHOG_HOST: "" })).toEqual({
      token: "phc_1",
      host: "https://us.i.posthog.com",
    });
    expect(
      posthogBrowserConfig({
        POSTHOG_PROJECT_TOKEN: "phc_1",
        POSTHOG_HOST: "https://eu.i.posthog.com",
      }),
    ).toEqual({ token: "phc_1", host: "https://eu.i.posthog.com" });
  });
});
