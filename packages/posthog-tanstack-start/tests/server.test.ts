import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureServerEvent,
  captureServerException,
  installPostHogForTests,
  setSecretPaths,
} from "../src/server.js";

/** What a capture left the Worker with, as the stand-in client recorded it. */
type Sent =
  | {
      exception: unknown;
      distinctId?: string;
      properties?: unknown;
    }
  | {
      event: string;
      distinctId?: string;
      properties?: unknown;
    };

/** A property that holds itself, which `JSON.stringify` cannot write. */
interface Loop {
  page: string;
  self?: Loop;
}

const sent: Sent[] = [];

const record = () => {
  installPostHogForTests({
    captureImmediate: ({ event, distinctId, properties }) => {
      sent.push({ event, distinctId, properties });

      return Promise.resolve();
    },
    captureExceptionImmediate: (exception, distinctId, properties) => {
      sent.push({ exception, distinctId, properties });

      return Promise.resolve();
    },
  });
};

/**
 * posthog-node's own client, which builds each event and runs `before_send`, from a fresh module: one with no client
 * yet, so it makes the real one from the Worker's vars. `bodies` holds each request body as PostHog would get it.
 */
const realClient = async () => {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const gzipped = new Response(init.body).body;
    bodies.push(
      await new Response(
        gzipped?.pipeThrough(new DecompressionStream("gzip"))
      ).text()
    );

    return Response.json({ status: 1 });
  });
  vi.resetModules();
  const server = await import("../src/server.js");

  return { server, bodies };
};

describe("the Worker's PostHog client", () => {
  afterEach(() => {
    sent.length = 0;
    installPostHogForTests(null);
    setSecretPaths([]);
    vi.unstubAllGlobals();
  });

  describe(captureServerException, () => {
    it("reports an exception with the page's address but not its query, as the browser's person", () => {
      record();
      const error = new Error("boom");
      captureServerException(error, {
        request: new Request(
          "https://app.example.com/api/files/upload?name=report.pdf",
          {
            method: "PUT",
            headers: {
              "x-posthog-distinct-id": "usr_1",
              "x-posthog-session-id": "ses_1",
            },
          }
        ),
      });
      expect(sent).toStrictEqual([
        {
          exception: error,
          distinctId: "usr_1",
          properties: {
            $current_url: "https://app.example.com/api/files/upload",
            $pathname: "/api/files/upload",
            request_method: "PUT",
            $session_id: "ses_1",
          },
        },
      ]);
    });

    it("reports a page whose address is its key by the route's pattern", () => {
      record();
      setSecretPaths(["/t/$token", "/u/$token"]);
      captureServerException(new Error("render"), {
        request: new Request(
          "https://app.example.com/t/k3y0f4t1ck3t?opened=true"
        ),
      });
      captureServerException(new Error("render"), {
        request: new Request("https://app.example.com/u/l1stk3y/confirm", {
          method: "POST",
        }),
      });
      expect(sent.map((s) => s.properties)).toStrictEqual([
        {
          $current_url: "https://app.example.com/t/$token",
          $pathname: "/t/$token",
          request_method: "GET",
        },
        {
          $current_url: "https://app.example.com/u/$token/confirm",
          $pathname: "/u/$token/confirm",
          request_method: "POST",
        },
      ]);
      expect(JSON.stringify(sent)).not.toMatch(/k3y/u);
    });

    it("throws at setup for a secret path the router reads differently", () => {
      expect(() => setSecretPaths(["/files/$/edit"])).toThrow(
        'Secret path "/files/$/edit" goes on after its splat'
      );
    });

    it("sends a secret page's address in the exception's message, stack and properties as the route's pattern", async () => {
      const { server, bodies } = await realClient();
      server.setSecretPaths(["/t/$token"]);

      const request = new Request("https://app.example.com/t/k3y0f4t1ck3t");
      const error = new Error(`ticket ${request.url} not found`);
      // PostHog gets the stack as frames; this one ran from under the secret page.
      error.stack = `Error: ${error.message}\n    at loadTicket (${request.url}/ticket.js:3:9)`;
      server.captureServerException(error, {
        request,
        properties: { link: request.url },
      });

      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      expect(JSON.parse(bodies[0] ?? "")).toMatchObject({
        batch: [
          {
            event: "$exception",
            properties: {
              $exception_list: [
                {
                  value: "ticket https://app.example.com/t/$token not found",
                  stacktrace: {
                    frames: [
                      {
                        function: "loadTicket",
                        filename: "https://app.example.com/t/$token/ticket.js",
                      },
                    ],
                  },
                },
              ],
              $current_url: "https://app.example.com/t/$token",
              link: "https://app.example.com/t/$token",
            },
          },
        ],
      });
      expect(bodies[0]).not.toMatch(/k3y/u);
    });

    it("reads the person and session from the SDK's cookie on a page load", () => {
      record();

      const state = {
        distinct_id: "usr_3",
        $sesid: [1_761_523_200_000, "ses_3", 1_761_523_100_000],
      };

      captureServerException(new Error("render"), {
        request: new Request("https://app.example.com/app/inbox", {
          headers: {
            cookie: `sid=abc; ph_phc_test_posthog=${encodeURIComponent(JSON.stringify(state))}`,
          },
        }),
      });
      expect(sent).toStrictEqual([
        {
          exception: expect.any(Error),
          distinctId: "usr_3",
          properties: {
            $current_url: "https://app.example.com/app/inbox",
            $pathname: "/app/inbox",
            request_method: "GET",
            $session_id: "ses_3",
          },
        },
      ]);
    });

    it("reports without a person when the cookie cannot be read", () => {
      record();
      captureServerException(new Error("render"), {
        request: new Request("https://app.example.com/", {
          headers: { cookie: "ph_phc_test_posthog=%E0%A4%A" },
        }),
      });
      expect(sent).toStrictEqual([
        {
          exception: expect.any(Error),
          distinctId: undefined,
          properties: {
            $current_url: "https://app.example.com/",
            $pathname: "/",
            request_method: "GET",
          },
        },
      ]);
    });

    it("names the person from a handler that knows them, and adds its properties", () => {
      record();
      captureServerException(new Error("model down"), {
        distinctId: "usr_2",
        properties: { handler: "assistant", stage: "model" },
      });
      expect(sent).toStrictEqual([
        {
          exception: expect.any(Error),
          distinctId: "usr_2",
          properties: { handler: "assistant", stage: "model" },
        },
      ]);
    });

    it("sends nothing while PostHog is off", () => {
      captureServerException(new Error("quiet"));
      expect(sent).toStrictEqual([]);
    });
  });

  describe(captureServerEvent, () => {
    it("sends an event as the person it names", () => {
      record();
      captureServerEvent("ticket_resolved", "usr_1", { channel: "email" });
      expect(sent).toStrictEqual([
        {
          event: "ticket_resolved",
          distinctId: "usr_1",
          properties: { channel: "email" },
        },
      ]);
    });

    it("sends an event without a person anonymously, under the id it is given", () => {
      record();
      captureServerEvent(
        "$ai_generation",
        undefined,
        { $ai_model: "m" },
        "conv_1"
      );
      expect(sent).toStrictEqual([
        {
          event: "$ai_generation",
          distinctId: "conv_1",
          properties: { $ai_model: "m", $process_person_profile: false },
        },
      ]);
    });

    it("reads an empty id as no person, never as the id", () => {
      record();
      captureServerEvent("$ai_generation", "", { $ai_model: "m" }, "conv_1");
      expect(sent).toStrictEqual([
        {
          event: "$ai_generation",
          distinctId: "conv_1",
          properties: { $ai_model: "m", $process_person_profile: false },
        },
      ]);
    });

    it("sends a secret page's address in an event's properties as the route's pattern", async () => {
      const { server, bodies } = await realClient();
      server.setSecretPaths(["/t/$token"]);
      server.captureServerEvent("ticket_shared", "usr_1", {
        link: "https://app.example.com/t/k3y0f4t1ck3t",
        recipients: [{ page: "/t/k3y0f4t1ck3t/confirm" }],
      });

      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      expect(JSON.parse(bodies[0] ?? "")).toMatchObject({
        batch: [
          {
            event: "ticket_shared",
            properties: {
              link: "https://app.example.com/t/$token",
              recipients: [{ page: "/t/$token/confirm" }],
            },
          },
        ],
      });
      expect(bodies[0]).not.toMatch(/k3y/u);
    });

    it("sends an event as it is while no secret paths are set", async () => {
      const { server, bodies } = await realClient();
      // Nothing walks the properties, so one that holds itself still goes, as posthog-node writes it.
      const loop: Loop = { page: "/t/k3y0f4t1ck3t" };
      loop.self = loop;
      server.captureServerEvent("ticket_viewed", "usr_1", { loop });

      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      expect(JSON.parse(bodies[0] ?? "")).toMatchObject({
        batch: [
          {
            event: "ticket_viewed",
            properties: {
              loop: { page: "/t/k3y0f4t1ck3t", self: "[Circular]" },
            },
          },
        ],
      });
    });

    it("sends an event whose property holds itself with the secret paths as their pattern", async () => {
      const { server, bodies } = await realClient();
      server.setSecretPaths(["/t/$token"]);
      const loop: Loop = { page: "/t/k3y0f4t1ck3t" };
      loop.self = loop;
      server.captureServerEvent("ticket_viewed", "usr_1", { loop });

      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      expect(JSON.parse(bodies[0] ?? "")).toMatchObject({
        batch: [
          {
            event: "ticket_viewed",
            properties: { loop: { page: "/t/$token", self: "[Circular]" } },
          },
        ],
      });
      expect(bodies[0]).not.toMatch(/k3y/u);
    });
  });
});
