import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
import { redactSecretPaths } from "../src/browser.js";
import { pathRedactor, redactDeep } from "../src/secret-paths.js";

const redact = pathRedactor(["/t/$token", "/q/$token", "/u/$token"]);

describe("pathRedactor", () => {
  it("names a secret path by its pattern, in a path or a whole address", () => {
    expect(redact("/t/k3y0f4t1ck3t")).toBe("/t/$token");
    expect(redact("https://app.example.com/q/k3y0f4qu0t3k3y0f4qu0t3")).toBe(
      "https://app.example.com/q/$token",
    );
  });

  it("matches a secret path in any case, as the router does", () => {
    expect(redact("https://app.example.com/T/K3Y0F4T1CK3T")).toBe(
      "https://app.example.com/t/$token",
    );
  });

  it("keeps what follows the secret: the page under it, a query, a fragment", () => {
    expect(redact("https://app.example.com/u/l1stk3y/confirm")).toBe(
      "https://app.example.com/u/$token/confirm",
    );
    expect(redact("/t/k3y?opened=true#reply")).toBe("/t/$token?opened=true#reply");
  });

  it("finds every secret path in a text", () => {
    expect(redact("from /t/aaa to /q/bbb")).toBe("from /t/$token to /q/$token");
    expect(redact('<a href="/t/aaa">ticket</a>')).toBe('<a href="/t/$token">ticket</a>');
  });

  it("leaves other paths alone, the patterns' own words included", () => {
    for (const text of [
      "/",
      "/contact",
      "/t",
      "/t/",
      "/app/tickets/abc",
      "/chat?embed=1",
      "/at/abc",
    ])
      expect(redact(text), text).toBe(text);
  });

  it("matches the pattern's fixed parts as written", () => {
    const dotted = pathRedactor(["/a.b/$id"]);
    expect(dotted("/a.b/secret")).toBe("/a.b/$id");
    expect(dotted("/axb/secret")).toBe("/axb/secret");
  });
});

describe("redactDeep", () => {
  it("redacts strings at any depth and in object keys, and keeps everything else", () => {
    const when = new Date(0);
    expect(
      redactDeep(
        {
          $current_url: "https://app.example.com/t/aaa",
          $elements: [{ attr__href: "/q/bbb", nth_child: 2 }],
          $heatmap_data: { "https://app.example.com/t/aaa": [{ x: 1 }] },
          when,
          ok: true,
          none: null,
        },
        redact,
      ),
    ).toEqual({
      $current_url: "https://app.example.com/t/$token",
      $elements: [{ attr__href: "/q/$token", nth_child: 2 }],
      $heatmap_data: { "https://app.example.com/t/$token": [{ x: 1 }] },
      when,
      ok: true,
      none: null,
    });
  });
});

describe("redactSecretPaths", () => {
  const beforeSend = redactSecretPaths(["/t/$token"]);
  const event = (overrides: Partial<CaptureResult>): CaptureResult => ({
    uuid: "0190",
    event: "$pageview",
    properties: {},
    ...overrides,
  });

  it("sends an event's addresses and the person's first address by pattern", () => {
    expect(
      beforeSend(
        event({
          properties: {
            $current_url: "https://app.example.com/t/aaa?opened=true",
            $pathname: "/t/aaa",
            $referrer: "https://app.example.com/t/aaa",
            $set_once: { $initial_pathname: "/t/aaa" },
          },
          $set_once: { $initial_current_url: "https://app.example.com/t/aaa" },
        }),
      ),
    ).toEqual(
      event({
        properties: {
          $current_url: "https://app.example.com/t/$token?opened=true",
          $pathname: "/t/$token",
          $referrer: "https://app.example.com/t/$token",
          $set_once: { $initial_pathname: "/t/$token" },
        },
        $set: undefined,
        $set_once: { $initial_current_url: "https://app.example.com/t/$token" },
      }),
    );
  });

  it("leaves session replay's compressed snapshots as they are", () => {
    const snapshot = event({ event: "$snapshot", properties: { $snapshot_data: ["/t/aaa"] } });
    expect(beforeSend(snapshot)).toBe(snapshot);
  });
});
