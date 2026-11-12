import { env, waitUntil } from "cloudflare:workers";
import { PostHog } from "posthog-node";
import type { BeforeSendFn } from "posthog-node";

import { isString } from "./guards.js";
import { POSTHOG_MISSING } from "./missing.js";
import { pathRedactor, redactDeep } from "./secret-paths.js";
import type { PathRedactor } from "./secret-paths.js";

/** What the browser's own SDK says about who is asking, read from the request. */
interface BrowserIdentity {
  distinctId?: string;
  sessionId?: string;
}

let client: PostHog | null | undefined;

// Null until the app lists its secret paths: an app without them sends every event as it is, unwalked.
let redactPath: PathRedactor | null = null;

/**
 * The app's routes whose address is a credential (a shared ticket's page `/t/$token`), which everything the Worker
 * sends reports by their pattern: an exception's URL, message and stack, and the properties of every exception and
 * event. Called once from the Worker's entry module, so it holds for every handler and Durable Object.
 * Throws for a pattern the router would read differently, such as `prefix$id`.
 */
export const setSecretPaths = (patterns: readonly string[]) => {
  redactPath = patterns.length > 0 ? pathRedactor(patterns) : null;
};

/** `pathname` with its secret paths as their pattern. */
const redactPathname = (pathname: string) =>
  redactPath ? redactPath(pathname) : pathname;

/**
 * An event's text is whatever the code behind it wrote (a handler's ``new Error(`${request.url} not found`)``, a fetch
 * error's address, a property that quotes a link), so every string of the event posthog-node builds leaves with the
 * secret paths as their pattern, as the browser's `redactSecretPaths` does. It reads `redactPath` as it sends, so a
 * `setSecretPaths` after the client exists still holds.
 */
const redactEvent: BeforeSendFn = (event) =>
  redactPath
    ? { ...event, properties: redactDeep(event.properties, redactPath) }
    : event;

/**
 * The server-side PostHog client (posthog-node resolves to its workerd build), or null when the Worker's
 * POSTHOG_PROJECT_TOKEN is empty. Every event is sent on its own with the *Immediate methods and kept alive with
 * waitUntil, so nothing waits in an in-memory batch that the isolate could drop or that a later request would have
 * to flush.
 */
const posthogServer = (): PostHog | null => {
  if (client === undefined) {
    if (env.POSTHOG_PROJECT_TOKEN) {
      client = new PostHog(env.POSTHOG_PROJECT_TOKEN, {
        host: env.POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 0,
        before_send: redactEvent,
      });
    } else {
      if (import.meta.env?.DEV && import.meta.env.MODE !== "test") {
        console.error(new Error(POSTHOG_MISSING));
      }

      client = null;
    }
  }

  return client;
};

/** Puts a stand-in in the client's place (null: PostHog off), so a test can read what would have left the Worker. */
export const installPostHogForTests = (
  fake: Pick<PostHog, "captureImmediate" | "captureExceptionImmediate"> | null
) => {
  // SAFETY: the package calls these two methods alone, so a stand-in with them stands in for the client.
  client = fake as PostHog | null;
};

/** Logs a send that failed rather than leaving its rejection unhandled; the request is long gone. */
const warnOnFailure = async (what: string, send: Promise<unknown>) => {
  try {
    await send;
  } catch (error) {
    // SAFETY: posthog-node rejects with an Error.
    console.warn(what, (error as Error).message);
  }
};

/** Keep a send alive past the response. Outside a request context (waitUntil throws there) the fetch still runs. */
const keepAlive = (promise: Promise<unknown>) => {
  try {
    waitUntil(promise);
  } catch {
    /* no request context */
  }
};

const readCookie = (request: Request, name: string): string | null => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(value.join("="));
    }
  }

  return null;
};

/**
 * The browser's PostHog identity for a request. posthog-js adds tracing headers to same-origin fetches (server
 * functions, /api; `initPostHog` turns them on); document requests cannot carry them, so those fall back to the SDK's
 * own cookie.
 */
const browserIdentity = (request: Request): BrowserIdentity => {
  const distinctId = request.headers.get("x-posthog-distinct-id");

  if (distinctId) {
    return {
      distinctId,
      sessionId: request.headers.get("x-posthog-session-id") ?? undefined,
    };
  }

  try {
    const cookie = readCookie(
      request,
      `ph_${env.POSTHOG_PROJECT_TOKEN}_posthog`
    );

    if (!cookie) {
      return {};
    }

    // SAFETY: the SDK writes its own cookie as JSON; every field is read through a check below.
    const state = JSON.parse(cookie) as {
      distinct_id?: unknown;
      $sesid?: unknown;
    };

    return {
      distinctId: isString(state.distinct_id) ? state.distinct_id : undefined,
      sessionId:
        Array.isArray(state.$sesid) && isString(state.$sesid[1])
          ? state.$sesid[1]
          : undefined,
    };
  } catch {
    return {};
  }
};

/**
 * Send one event without blocking the response. Without a distinctId the event is anonymous (no person profile)
 * under `anonymousId`, so related events (one conversation's AI calls) still share an id. Its properties leave with
 * the secret paths (`setSecretPaths`) as their pattern.
 */
export const captureServerEvent = (
  event: string,
  distinctId: string | undefined,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- an event's properties are whatever PostHog takes as JSON
  properties: Record<string, unknown>,
  anonymousId?: string
) => {
  const ph = posthogServer();

  if (!ph) {
    return;
  }

  const anonymous = !distinctId;
  keepAlive(
    warnOnFailure(
      "posthog capture failed",
      ph.captureImmediate({
        event,
        // `||`, as `anonymous` reads it: an empty id (`user?.id ?? ""`) is no person.
        distinctId: distinctId || anonymousId || crypto.randomUUID(),
        properties: anonymous
          ? { ...properties, $process_person_profile: false }
          : properties,
      })
    )
  );
};

/**
 * Report an exception to PostHog error tracking. With a request, the exception carries the URL without its query (a
 * widget token, a search term, an OAuth request's parameters) and with its secret paths as their pattern
 * (`setSecretPaths`), and the browser's person and session, which links it to the session replay where there is one.
 * A handler that knows the person passes `distinctId`.
 */
export const captureServerException = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a handler caught, which PostHog error tracking takes as it is
  error: unknown,
  context: {
    request?: Request;
    distinctId?: string;
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the extra properties an app sends with the exception, as JSON
    properties?: Record<string, unknown>;
  } = {}
) => {
  const ph = posthogServer();

  if (!ph) {
    return;
  }

  const { request } = context;
  const url = request ? new URL(request.url) : null;
  const browser = request ? browserIdentity(request) : {};
  const { sessionId } = browser;
  const distinctId = context.distinctId ?? browser.distinctId;

  const properties = {
    ...(url &&
      request && {
        $current_url: url.origin + redactPathname(url.pathname),
        $pathname: redactPathname(url.pathname),
        request_method: request.method,
      }),
    ...(sessionId && { $session_id: sessionId }),
    ...context.properties,
  };

  // oxlint-disable-next-line promise/no-promise-in-callback -- not a callback: the rule reads an exported function whose first parameter is named `error` as an error-first one
  const send = ph.captureExceptionImmediate(error, distinctId, properties);

  keepAlive(warnOnFailure("posthog exception capture failed", send));
};
