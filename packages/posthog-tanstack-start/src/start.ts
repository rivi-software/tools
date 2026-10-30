import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware, createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { PostHogBrowserConfig } from "./browser.js";
import { captureServerException } from "./server.js";

/**
 * Server functions (loaders and form actions) turn a thrown error into an error response before it reaches the
 * Worker, so they report to PostHog here. Redirects and notFound are control flow, not failures. Goes into the Start
 * instance's `functionMiddleware`.
 */
export const posthogFunctionErrors = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (!isRedirect(error) && !isNotFound(error))
        captureServerException(error, { request: getRequest() });
      throw error;
    }
  },
);

/**
 * Server routes (/login, /logout, /api/*) answer a thrown error with a 500 themselves, so they report here. Goes into
 * the Start instance's `requestMiddleware`.
 */
export const posthogRequestErrors = createMiddleware().server(async ({ next, request }) => {
  try {
    return await next();
  } catch (error) {
    if (!(error instanceof Response) && !isRedirect(error) && !isNotFound(error))
      captureServerException(error, { request });
    throw error;
  }
});

/**
 * The browser SDK's settings for `initPostHog`. They are the Worker vars, read during SSR in the router's
 * `dehydrate` and handed to the client through router dehydration, so one value configures the browser and the
 * server.
 */
export const getPostHogBrowserConfig = createServerOnlyFn((): PostHogBrowserConfig | null =>
  env.POSTHOG_PROJECT_TOKEN
    ? { token: env.POSTHOG_PROJECT_TOKEN, host: env.POSTHOG_HOST || "https://us.i.posthog.com" }
    : null,
);
