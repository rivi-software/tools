import { afterEach, describe, expect, it } from "vitest";
import {
  captureServerEvent,
  captureServerException,
  installPostHogForTests,
  setSecretPaths,
} from "../src/server.js";

type Sent =
  | { exception: unknown; distinctId?: string; properties?: Record<string, unknown> }
  | { event: string; distinctId?: string; properties?: Record<string, unknown> };

const sent: Sent[] = [];

function record() {
  installPostHogForTests({
    captureImmediate: async ({ event, distinctId, properties }) => {
      sent.push({ event, distinctId, properties });
    },
    captureExceptionImmediate: async (exception, distinctId, properties) => {
      sent.push({ exception, distinctId, properties });
    },
  });
}

afterEach(() => {
  sent.length = 0;
  installPostHogForTests(null);
  setSecretPaths([]);
});

describe("captureServerException", () => {
  it("reports an exception with the page's address but not its query, as the browser's person", () => {
    record();
    const error = new Error("boom");
    captureServerException(error, {
      request: new Request("https://app.example.com/api/files/upload?name=report.pdf", {
        method: "PUT",
        headers: { "x-posthog-distinct-id": "usr_1", "x-posthog-session-id": "ses_1" },
      }),
    });
    expect(sent).toEqual([
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
      request: new Request("https://app.example.com/t/k3y0f4t1ck3t?opened=true"),
    });
    captureServerException(new Error("render"), {
      request: new Request("https://app.example.com/u/l1stk3y/confirm", { method: "POST" }),
    });
    expect(sent.map((s) => s.properties)).toEqual([
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
    expect(JSON.stringify(sent)).not.toMatch(/k3y/);
  });

  it("reads the person and session from the SDK's cookie on a page load", () => {
    record();
    const state = { distinct_id: "usr_3", $sesid: [1761523200000, "ses_3", 1761523100000] };
    captureServerException(new Error("render"), {
      request: new Request("https://app.example.com/app/inbox", {
        headers: {
          cookie: `sid=abc; ph_phc_test_posthog=${encodeURIComponent(JSON.stringify(state))}`,
        },
      }),
    });
    expect(sent).toEqual([
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
    expect(sent).toEqual([
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
    expect(sent).toEqual([
      {
        exception: expect.any(Error),
        distinctId: "usr_2",
        properties: { handler: "assistant", stage: "model" },
      },
    ]);
  });

  it("sends nothing while PostHog is off", () => {
    captureServerException(new Error("quiet"));
    expect(sent).toEqual([]);
  });
});

describe("captureServerEvent", () => {
  it("sends an event as the person it names", () => {
    record();
    captureServerEvent("ticket_resolved", "usr_1", { channel: "email" });
    expect(sent).toEqual([
      { event: "ticket_resolved", distinctId: "usr_1", properties: { channel: "email" } },
    ]);
  });

  it("sends an event without a person anonymously, under the id it is given", () => {
    record();
    captureServerEvent("$ai_generation", undefined, { $ai_model: "m" }, "conv_1");
    expect(sent).toEqual([
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
    expect(sent).toEqual([
      {
        event: "$ai_generation",
        distinctId: "conv_1",
        properties: { $ai_model: "m", $process_person_profile: false },
      },
    ]);
  });
});
