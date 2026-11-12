import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";

import { redactSecretPaths } from "../src/browser.js";
import { pathRedactor, redactDeep } from "../src/secret-paths.js";

/** An object that holds itself, which `JSON.stringify` cannot write. */
interface Loop {
  page: string;
  self?: Loop;
  pages?: Loop[];
}

const redact = pathRedactor(["/t/$token", "/q/$token", "/u/$token"]);

const event = (overrides: Partial<CaptureResult>): CaptureResult => ({
  uuid: "0190",
  event: "$pageview",
  properties: {},
  ...overrides,
});

describe(pathRedactor, () => {
  it("names a secret path by its pattern, in a path or a whole address", () => {
    expect(redact("/t/k3y0f4t1ck3t")).toBe("/t/$token");
    expect(redact("https://app.example.com/q/k3y0f4qu0t3k3y0f4qu0t3")).toBe(
      "https://app.example.com/q/$token"
    );
  });

  it("matches a secret path in any case, as the router does", () => {
    expect(redact("https://app.example.com/T/K3Y0F4T1CK3T")).toBe(
      "https://app.example.com/t/$token"
    );
  });

  it("keeps what follows the secret: the page under it, a query, a fragment", () => {
    expect(redact("https://app.example.com/u/l1stk3y/confirm")).toBe(
      "https://app.example.com/u/$token/confirm"
    );
    expect(redact("/t/k3y?opened=true#reply")).toBe(
      "/t/$token?opened=true#reply"
    );
  });

  it("finds every secret path in a text", () => {
    expect(redact("from /t/aaa to /q/bbb")).toBe("from /t/$token to /q/$token");
    expect(redact('<a href="/t/aaa">ticket</a>')).toBe(
      '<a href="/t/$token">ticket</a>'
    );
  });

  it.each([
    "/",
    "/contact",
    "/t",
    "/t/",
    "/app/tickets/abc",
    "/chat?embed=1",
    "/at/abc",
  ])("leaves %o alone, the patterns' own words included", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("matches the pattern's fixed parts as written", () => {
    const dotted = pathRedactor(["/a.b/$id"]);
    expect(dotted("/a.b/secret")).toBe("/a.b/$id");
    expect(dotted("/axb/secret")).toBe("/axb/secret");
  });

  it.each([
    // A splat: the rest of the path, slashes included.
    ["/files/$", "/files/a/b/s3cr3t", "/files/$"],
    [
      "/files/$",
      "https://app.example.com/files/a/s3cr3t?download=1#top",
      "https://app.example.com/files/$?download=1#top",
    ],
    ["/files/{$}", "/files/a/s3cr3t", "/files/{$}"],
    ["/files/v{$}.zip", "/files/va/s3cr3t.zip", "/files/v{$}.zip"],
    ["/files/{$}/edit", "/files/a/s3cr3t/edit", "/files/{$}/edit"],
    // One segment, with fixed text around the braces.
    ["/t/{$token}", "/t/s3cr3t", "/t/{$token}"],
    ["/t/{$token}.pdf", "/t/s3cr3t.pdf", "/t/{$token}.pdf"],
    ["/t/prefix{$id}", "/t/prefixS3CR3T", "/t/prefix{$id}"],
    ["/t/ticket-{$id}.pdf", "/T/TICKET-s3cr3t.PDF", "/t/ticket-{$id}.pdf"],
    ["/t/{$token}/confirm", "/t/s3cr3t/confirm", "/t/{$token}/confirm"],
    // An optional segment, when it is there.
    ["/t/{-$token}", "/t/s3cr3t", "/t/{-$token}"],
    ["/t/{-$token}/confirm", "/t/s3cr3t/confirm", "/t/{-$token}/confirm"],
    ["/t/{-$a}/{-$b}", "/t/s3cr3t", "/t/{-$a}/{-$b}"],
    // An index route's trailing slash.
    ["/t/$token/", "/t/s3cr3t", "/t/$token/"],
    ["/t/$token/", "/t/s3cr3t/", "/t/$token/"],
  ])(
    "reads %o as the router does, so %o leaves as %o",
    (pattern, text, redacted) => {
      expect(pathRedactor([pattern])(text)).toBe(redacted);
    }
  );

  it.each([
    ["/files/$", "/files"],
    ["/files/$", "/filesystem/a"],
    ["/t/{$token}.pdf", "/t/report.png"],
    ["/t/prefix{$id}", "/t/other"],
    ["/t/{-$token}", "/t"],
    ["/t/{-$token}", "/tickets"],
    ["/t/{-$token}/confirm", "/t/confirm"],
  ])("with %o, leaves %o alone: it holds no secret", (pattern, text) => {
    expect(pathRedactor([pattern])(text)).toBe(text);
  });

  it.each([
    // The router reads these as fixed text, so they would never match the link.
    "/t/prefix$id",
    "/t/{token}",
    "/t/{$token",
    "/t/{$a}-{$b}",
    "/t/{-$}",
    // The router ignores what follows `$`, and reads what follows `{$}` as fixed text.
    "/files/$/edit",
    "/files/{$}/$id",
  ])("throws for %o, which the router reads differently", (pattern) => {
    expect(() => pathRedactor(["/q/$token", pattern])).toThrow(
      `Secret path "${pattern}"`
    );
  });
});

describe(redactDeep, () => {
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
        redact
      )
    ).toStrictEqual({
      $current_url: "https://app.example.com/t/$token",
      $elements: [{ attr__href: "/q/$token", nth_child: 2 }],
      $heatmap_data: { "https://app.example.com/t/$token": [{ x: 1 }] },
      when,
      ok: true,
      none: null,
    });
  });

  it("ends a cycle as posthog-node writes one, and redacts an object each place it appears", () => {
    const loop: Loop = { page: "/t/aaa" };
    loop.self = loop;
    loop.pages = [loop];
    const shared = { page: "/q/bbb" };
    expect(
      redactDeep({ loop, first: shared, second: shared }, redact)
    ).toStrictEqual({
      loop: { page: "/t/$token", self: "[Circular]", pages: ["[Circular]"] },
      first: { page: "/q/$token" },
      second: { page: "/q/$token" },
    });
  });
});

describe(redactSecretPaths, () => {
  const beforeSend = redactSecretPaths(["/t/$token"]);

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
        })
      )
    ).toStrictEqual(
      event({
        properties: {
          $current_url: "https://app.example.com/t/$token?opened=true",
          $pathname: "/t/$token",
          $referrer: "https://app.example.com/t/$token",
          $set_once: { $initial_pathname: "/t/$token" },
        },
        $set: undefined,
        $set_once: { $initial_current_url: "https://app.example.com/t/$token" },
      })
    );
  });

  it("throws at setup for a pattern the router reads differently", () => {
    expect(() => redactSecretPaths(["/t/prefix$id"])).toThrow(
      'Secret path "/t/prefix$id" has a part TanStack Router reads as fixed text: "prefix$id".'
    );
  });

  it("leaves session replay's compressed snapshots as they are", () => {
    const snapshot = event({
      event: "$snapshot",
      properties: { $snapshot_data: ["/t/aaa"] },
    });

    expect(beforeSend(snapshot)).toBe(snapshot);
  });
});
