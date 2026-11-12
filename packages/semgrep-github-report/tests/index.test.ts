import { describe, expect, it } from "vitest";

import {
  COMMENT_MARKER,
  formatFindingsComment,
  formatFindingsSummary,
  parseFindings,
  semgrepFingerprint,
} from "../src/index.js";
import type { SemgrepFinding } from "../src/index.js";

describe(semgrepFingerprint, () => {
  it("uses Semgrep fingerprint when present, under extra as semgrep scan --json writes it", () => {
    const fromCloud = {
      check_id: "example.rule",
      path: "src/a.ts",
      start: { line: 1 },
      end: { line: 1 },
      extra: { message: "x", severity: "LOW", fingerprint: "cloud-fp-123" },
    };

    expect(semgrepFingerprint(fromCloud)).toBe("cloud-fp-123");
  });

  it("hashes rule, path, and lines when cloud fingerprint requires login", () => {
    const needsLogin = {
      check_id: "example.rule",
      path: "src/a.ts",
      start: { line: 10 },
      end: { line: 12 },
      extra: { message: "x", severity: "LOW", fingerprint: "requires login" },
    };

    const a = semgrepFingerprint(needsLogin);
    const b = semgrepFingerprint({ ...needsLogin, start: { line: 11 } });
    expect(a).toHaveLength(40);
    expect(a).not.toBe(b);
    expect(
      semgrepFingerprint({
        ...needsLogin,
        extra: { message: "x", severity: "LOW" },
      })
    ).toBe(a);
  });
});

const finding = (file: string, line: number): SemgrepFinding => ({
  check_id: "example.rule",
  path: file,
  start: { line },
  end: { line },
  extra: {
    message: "Something risky",
    severity: "ERROR",
    metadata: { shortlink: "https://sg.run/x" },
    fingerprint: "requires login",
  },
});

const revision = { repository: "acme/app", sha: "abc123" };

describe(formatFindingsSummary, () => {
  it("lists each finding with its rule and a link to the scanned line", () => {
    const summary = formatFindingsSummary(
      [finding("src/routes/chat.tsx", 170)],
      revision
    );

    expect(summary).toBe(
      "## Semgrep findings on `abc123` (1)\n\n" +
        "| Severity | Rule | Location |\n| --- | --- | --- |\n" +
        "| ERROR | [`example.rule`](https://sg.run/x) | [`src/routes/chat.tsx:170`](https://github.com/acme/app/blob/abc123/src/routes/chat.tsx#L170) |\n"
    );
  });

  it("says so when the scan found nothing", () => {
    expect(formatFindingsSummary([], revision)).toBe(
      "## Semgrep findings on `abc123` (0)\n\nNo findings.\n"
    );
  });

  it("links to the GitHub server it is given, with each part of the path encoded", () => {
    const summary = formatFindingsSummary(
      [finding("docs/Q&A #2/run me.sh", 3)],
      {
        ...revision,
        serverUrl: "https://github.example.com",
      }
    );

    expect(summary).toContain(
      "[`docs/Q&A #2/run me.sh:3`](https://github.example.com/acme/app/blob/abc123/docs/Q%26A%20%232/run%20me.sh#L3)"
    );
  });

  it("escapes a | in a path, so the row keeps its three cells", () => {
    expect(
      formatFindingsSummary([finding("src/a|b.ts", 7)], revision)
    ).toContain(
      "| ERROR | [`example.rule`](https://sg.run/x) | [`src/a\\|b.ts:7`](https://github.com/acme/app/blob/abc123/src/a%7Cb.ts#L7) |\n"
    );
  });

  it("leaves the rule unlinked when Semgrep gives no shortlink", () => {
    const { metadata: _, ...extra } = finding("src/a.ts", 1).extra;

    const summary = formatFindingsSummary(
      [{ ...finding("src/a.ts", 1), extra }],
      revision
    );

    expect(summary).toContain("| ERROR | `example.rule` | ");
  });
});

/** A comment for more findings than even a table of them fits in. */
const tooLongTable = () =>
  formatFindingsComment(
    Array.from({ length: 1000 }, (_, index) =>
      finding(
        `src/a/rather/deeply/nested/directory/file-${index}.ts`,
        index + 1
      )
    ),
    revision
  );

/** How many finding rows a comment lists. */
const rowsListed = (comment: string) =>
  comment.match(/^\| ERROR \|/gmu)?.length ?? 0;

describe(formatFindingsComment, () => {
  it("opens with the marker, then lists the findings and each one's message and fingerprint", () => {
    const found = finding("src/routes/chat.tsx", 170);
    expect(formatFindingsComment([found], revision)).toBe(
      `${COMMENT_MARKER}\n## Semgrep findings\n\n` +
        "1 finding(s) on `abc123`.\n\n" +
        "| Severity | Rule | Location |\n| --- | --- | --- |\n" +
        "| ERROR | [`example.rule`](https://sg.run/x) | [`src/routes/chat.tsx:170`](https://github.com/acme/app/blob/abc123/src/routes/chat.tsx#L170) |\n\n" +
        "### `example.rule` — `src/routes/chat.tsx:170`\n\n" +
        "Something risky\n\n" +
        "Rule link: https://sg.run/x\n\n" +
        `Fingerprint: \`${semgrepFingerprint(found)}\`\n`
    );
  });

  it("says there are no new findings under the same marker, so it can replace an earlier list", () => {
    expect(formatFindingsComment([], revision)).toBe(
      `${COMMENT_MARKER}\n## Semgrep findings\n\nNo new findings on this revision.\n`
    );
  });

  it("leaves the messages out of a comment that would pass GitHub's 65,536 characters", () => {
    const findings = Array.from({ length: 100 }, (_, index) => ({
      ...finding(`src/file-${index}.ts`, index + 1),
      extra: {
        message: "Explained at length. ".repeat(50),
        severity: "WARNING",
      },
    }));

    const comment = formatFindingsComment(findings, revision);
    expect(comment.length).toBeLessThanOrEqual(65_536);
    expect(comment.startsWith(`${COMMENT_MARKER}\n`)).toBeTruthy();
    expect(comment.match(/^\| WARNING \|/gmu)).toHaveLength(100);
    expect(comment).not.toContain("Explained at length.");
    expect(comment).toMatch(
      /\n\nTheir messages are left out: GitHub limits a comment to 65,536 characters\.\n$/u
    );
  });

  it("lists only the rows that fit when even the table is too long", () => {
    const comment = tooLongTable();

    expect(comment.length).toBeLessThanOrEqual(65_536);
    expect(comment).toContain("\n1000 finding(s) on `abc123`.\n");

    const listed = rowsListed(comment);

    expect(listed).toBeGreaterThan(200);
    expect(listed).toBeLessThan(1000);
  });

  it("says how many rows it listed, and stops at the last one that fits", () => {
    const comment = tooLongTable();
    const listed = rowsListed(comment);

    expect(comment).toContain(
      `src/a/rather/deeply/nested/directory/file-${listed - 1}.ts:`
    );
    expect(comment).not.toContain(
      `src/a/rather/deeply/nested/directory/file-${listed}.ts:`
    );
    expect(comment).toMatch(
      new RegExp(
        `\\n\\nOnly the first ${listed} are listed, without their messages: GitHub limits a comment to 65,536 characters\\.\\n$`,
        "u"
      )
    );
  });
});

/** U+200D, which the comment puts after each `@`, `<` and `&` of a message. */
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x20_0d);

/** A finding in `src/a.ts` whose message is `message`. */
const findingSaying = (message: string): SemgrepFinding => {
  const found = finding("src/a.ts", 7);

  return { ...found, extra: { ...found.extra, message } };
};

describe("formatFindingsComment with text from the scanned code", () => {
  it("escapes a | in a path in the table, and only there", () => {
    const comment = formatFindingsComment([finding("src/a|b.ts", 7)], revision);

    expect(comment).toContain(
      "| ERROR | [`example.rule`](https://sg.run/x) | [`src/a\\|b.ts:7`](https://github.com/acme/app/blob/abc123/src/a%7Cb.ts#L7) |\n"
    );
    expect(comment).toContain("\n### `example.rule` — `src/a|b.ts:7`\n");
  });

  it("keeps an @ mention in a message from notifying anyone, written out or as a character reference", () => {
    const comment = formatFindingsComment(
      [findingSaying("Ask @some-org/some-team, or &#64;someone.")],
      revision
    );

    expect(comment).toContain(
      `\n\nAsk @${ZERO_WIDTH_JOINER}some-org/some-team, or &${ZERO_WIDTH_JOINER}#64;someone.\n\n`
    );
    expect(comment).not.toMatch(/@\w|&#/u);
  });

  it("leaves links, email addresses and text that is not markup as written", () => {
    const message =
      "See https://example.com/search?q=x&lang=en, (https://www.npmjs.com/package/@scope/pkg) " +
      "and [the docs](https://example.com/?a=1&b=2), or write to security@example.com. " +
      "Use `a && b`, not a < b.";

    expect(formatFindingsComment([findingSaying(message)], revision)).toContain(
      `\n\n${message}\n\n`
    );
  });

  it("keeps a mention that only looks as if it were in a link from notifying anyone", () => {
    const comment = formatFindingsComment(
      [
        findingSaying(
          "a/@someone, `(https://example.com/`@someone, [(https://example.com/](x)@someone, https://exa_mple.com/@someone"
        ),
      ],
      revision
    );

    expect(comment).not.toMatch(/@\w/u);
  });

  it("keeps a code fence in a message from turning the rest of the comment into code", () => {
    const comment = formatFindingsComment(
      [findingSaying("Matched:\n```js\nnever closed\n   ~~~")],
      revision
    );

    expect(comment).toContain(
      `\n\nMatched:\n${ZERO_WIDTH_JOINER}\`\`\`js\nnever closed\n   ${ZERO_WIDTH_JOINER}~~~\n\n`
    );
  });

  it("shows an unclosed <!-- in a message as text, so it hides nothing after it", () => {
    const comment = formatFindingsComment(
      [
        findingSaying("<!-- opens a comment that never closes"),
        finding("src/b.ts", 2),
      ],
      revision
    );

    expect(comment.replace(COMMENT_MARKER, "")).not.toContain("<!--");
    expect(comment).toContain(
      `\n\n<${ZERO_WIDTH_JOINER}!-- opens a comment that never closes\n\nRule link: https://sg.run/x\n\n`
    );
    expect(comment).toContain("\n### `example.rule` — `src/b.ts:2`\n");
  });

  it("joins nothing visible to a message's code, so a code span still shows it as written", () => {
    const comment = formatFindingsComment(
      [findingSaying("Avoid `<div dangerouslySetInnerHTML>`.")],
      revision
    );

    expect(comment).toContain(
      `\n\nAvoid \`<${ZERO_WIDTH_JOINER}div dangerouslySetInnerHTML>\`.\n\n`
    );
  });

  it("fences a path with backticks in one more backtick than its longest run", () => {
    const comment = formatFindingsComment(
      [finding("src/a``b`.ts", 7)],
      revision
    );

    expect(comment).toContain(
      "| [```src/a``b`.ts:7```](https://github.com/acme/app/blob/abc123/src/a%60%60b%60.ts#L7) |\n"
    );
    expect(comment).toContain("\n### `example.rule` — ```src/a``b`.ts:7```\n");
  });

  it("pads a code span whose text starts or ends with a backtick", () => {
    const comment = formatFindingsComment(
      [{ ...finding("`a.ts", 7), check_id: "example.rule`" }],
      revision
    );

    expect(comment).toContain("\n### `` example.rule` `` — `` `a.ts:7 ``\n");
  });

  it("keeps a path with a line break on its line, in the table and its heading", () => {
    const comment = formatFindingsComment(
      [finding("src/a\n<!--.ts", 7)],
      revision
    );

    expect(comment).toContain(
      "| ERROR | [`example.rule`](https://sg.run/x) | [`src/a <!--.ts:7`](https://github.com/acme/app/blob/abc123/src/a%0A%3C!--.ts#L7) |\n"
    );
    expect(comment).toContain("\n### `example.rule` — `src/a <!--.ts:7`\n");
  });
});

describe(parseFindings, () => {
  it("reads the results of semgrep scan --json", () => {
    const results = [finding("src/a.ts", 1)];
    expect(
      parseFindings(JSON.stringify({ version: "1.0.0", results, errors: [] }))
    ).toStrictEqual(results);
  });

  it("rejects JSON without a results array", () => {
    expect(() => parseFindings('{"errors": []}')).toThrow(
      "Not the JSON output of semgrep scan: it has no results array"
    );
    expect(() => parseFindings("null")).toThrow("no results array");
  });
});
