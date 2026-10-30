import { env, waitUntil } from "cloudflare:workers";
import { PostHog } from "posthog-node";
import { POSTHOG_MISSING } from "./missing.js";
import { pathRedactor, type PathRedactor } from "./secret-paths.js";

let client: PostHog | null | undefined;
let redactPath: PathRedactor = (text) => text;

/**
 * The app's routes whose address is a credential (a shared ticket's page `/t/$token`), which an exception reports by
 * their pattern. Called once from the Worker's entry module, so it holds for every handler and Durable Object.
 */
export function setSecretPaths(patterns: readonly string[]) {
  redactPath = pathRedactor(patterns);
}

/**
 * The server-side PostHog client (posthog-node resolves to its workerd build), or null when the Worker's
 * POSTHOG_PROJECT_TOKEN is empty. Every event is sent on its own with the *Immediate methods and kept alive with
 * waitUntil, so nothing waits in an in-memory batch that the isolate could drop or that a later request would have
 * to flush.
 */
function posthogServer(): PostHog | null {
  if (client === undefined) {
    if (env.POSTHOG_PROJECT_TOKEN) {
      client = new PostHog(env.POSTHOG_PROJECT_TOKEN, {
        host: env.POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 0,
      });
    } else {
      if (import.meta.env?.DEV && import.meta.env.MODE !== "test")
        console.error(new Error(POSTHOG_MISSING));
      client = null;
    }
  }
  return client;
}

/** Puts a stand-in in the client's place (null: PostHog off), so a test can read what would have left the Worker. */
export function installPostHogForTests(
  fake: Pick<PostHog, "captureImmediate" | "captureExceptionImmediate"> | null,
) {
  client = fake as PostHog | null;
}

/** Keep a send alive past the response. Outside a request context (waitUntil throws there) the fetch still runs. */
function keepAlive(promise: Promise<unknown>) {
  try {
    waitUntil(promise);
  } catch {
    /* no request context */
  }
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

/**
 * The browser's PostHog identity for a request. posthog-js adds tracing headers to same-origin fetches (server
 * functions, /api; `initPostHog` turns them on); document requests cannot carry them, so those fall back to the SDK's
 * own cookie.
 */
function browserIdentity(request: Request): { distinctId?: string; sessionId?: string } {
  const distinctId = request.headers.get("x-posthog-distinct-id");
  if (distinctId)
    return { distinctId, sessionId: request.headers.get("x-posthog-session-id") ?? undefined };
  try {
    const cookie = readCookie(request, `ph_${env.POSTHOG_PROJECT_TOKEN}_posthog`);
    if (!cookie) return {};
    const state = JSON.parse(cookie) as { distinct_id?: unknown; $sesid?: unknown };
    return {
      distinctId: typeof state.distinct_id === "string" ? state.distinct_id : undefined,
      sessionId:
        Array.isArray(state.$sesid) && typeof state.$sesid[1] === "string"
          ? state.$sesid[1]
          : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Send one event without blocking the response. Without a distinctId the event is anonymous (no person profile)
 * under `anonymousId`, so related events (one conversation's AI calls) still share an id.
 */
export function captureServerEvent(
  event: string,
  distinctId: string | undefined,
  properties: Record<string, unknown>,
  anonymousId?: string,
) {
  const ph = posthogServer();
  if (!ph) return;
  const anonymous = !distinctId;
  keepAlive(
    ph
      .captureImmediate({
        event,
        distinctId: distinctId ?? anonymousId ?? crypto.randomUUID(),
        properties: anonymous ? { ...properties, $process_person_profile: false } : properties,
      })
      .catch((err) => console.warn("posthog capture failed", (err as Error).message)),
  );
}

/**
 * Report an exception to PostHog error tracking. With a request, the exception carries the URL without its query (a
 * widget token, a search term, an OAuth request's parameters) and with its secret paths as their pattern
 * (`setSecretPaths`), and the browser's person and session, which links it to the session replay where there is one.
 * A handler that knows the person passes `distinctId`.
 */
export function captureServerException(
  error: unknown,
  context: { request?: Request; distinctId?: string; properties?: Record<string, unknown> } = {},
) {
  const ph = posthogServer();
  if (!ph) return;
  const { request } = context;
  const url = request ? new URL(request.url) : null;
  const browser = request ? browserIdentity(request) : {};
  const sessionId = browser.sessionId;
  const distinctId = context.distinctId ?? browser.distinctId;
  const properties = {
    ...(url &&
      request && {
        $current_url: url.origin + redactPath(url.pathname),
        $pathname: redactPath(url.pathname),
        request_method: request.method,
      }),
    ...(sessionId && { $session_id: sessionId }),
    ...context.properties,
  };
  keepAlive(
    ph
      .captureExceptionImmediate(error, distinctId, properties)
      .catch((err) => console.warn("posthog exception capture failed", (err as Error).message)),
  );
}
