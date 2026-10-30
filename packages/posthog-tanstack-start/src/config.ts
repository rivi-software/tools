import type { PostHogBrowserConfig } from "./browser.js";

/** PostHog's own default: US Cloud. An app on EU Cloud sets POSTHOG_HOST. */
export const DEFAULT_HOST = "https://us.i.posthog.com";

/**
 * The browser SDK's settings from the Worker vars, or null when POSTHOG_PROJECT_TOKEN is empty and
 * PostHog is off. `getPostHogBrowserConfig` (./start) reads them during SSR.
 */
export function posthogBrowserConfig(vars: {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
}): PostHogBrowserConfig | null {
  return vars.POSTHOG_PROJECT_TOKEN
    ? { token: vars.POSTHOG_PROJECT_TOKEN, host: vars.POSTHOG_HOST || DEFAULT_HOST }
    : null;
}
