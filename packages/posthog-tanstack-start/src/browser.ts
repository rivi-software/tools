import type { BeforeSendFn, PostHog, PostHogConfig } from "posthog-js";
import { POSTHOG_MISSING } from "./missing.js";
import { pathRedactor, redactDeep } from "./secret-paths.js";

/** The browser SDK's settings, from the Worker vars (`getPostHogBrowserConfig`). */
export type PostHogBrowserConfig = { token: string; host: string };

let ready: Promise<PostHog> | null = null;

/**
 * Starts posthog-js with the app's own `options` (what it captures, its consent rules), over the SDK defaults of
 * 2026-05-30. The SDK is its own chunk (about 100 kB gzipped) loaded after hydration, so no page waits for it.
 * Same-origin requests (server functions, /api) carry the browser's distinct and session id, so an exception
 * `captureServerException` reports links to the person and the session replay. A cookieless visitor sends no
 * distinct id.
 */
export function initPostHog(config: PostHogBrowserConfig | null, options: Partial<PostHogConfig>) {
  if (!config) {
    if (import.meta.env?.DEV) console.error(new Error(POSTHOG_MISSING));
    return;
  }
  ready ??= import("posthog-js").then(({ posthog }) => {
    posthog.init(config.token, {
      api_host: config.host,
      defaults: "2026-05-30",
      tracing_headers: [location.hostname],
      ...options,
    });
    return posthog;
  });
}

/** Run once the SDK has loaded; a no-op when PostHog is not configured. */
export function withPostHog(fn: (posthog: PostHog) => void) {
  void ready?.then(fn);
}

/**
 * A `before_send` for the app's routes whose address is a credential (a shared ticket's page `/t/$token`): every address
 * of them on an event or a person (`$current_url`, `$pathname`, `$referrer`, `$initial_current_url`, an autocaptured
 * link, the heatmap's keys) leaves as its route pattern. Session replay's `$snapshot` is compressed past reading, so
 * it goes as it is: replay stays off for an app that sets these, or blocks the paths in the project settings.
 */
export function redactSecretPaths(patterns: readonly string[]): BeforeSendFn {
  const redact = pathRedactor(patterns);
  return (event) =>
    event.event === "$snapshot"
      ? event
      : {
          ...event,
          properties: redactDeep(event.properties, redact),
          $set: redactDeep(event.$set, redact),
          $set_once: redactDeep(event.$set_once, redact),
        };
}

/** Errors the router's error boundaries catch never reach window.onerror, so they are reported here. */
export function captureClientException(error: unknown) {
  withPostHog((posthog) => posthog.captureException(error));
}
