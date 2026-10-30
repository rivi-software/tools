import { describe, expect, test } from "vitest";
import {
  COMMENT_MARKER,
  formatFindingsComment,
  formatFindingsSummary,
  parseFindings,
  type SemgrepFinding,
  semgrepFingerprint,
} from "../src/index.js";

describe("semgrepFingerprint", () => {
  test("uses Semgrep fingerprint when present, under extra as semgrep scan --json writes it", () => {
    const finding = {
      check_id: "example.rule",
      path: "src/a.ts",
      start: { line: 1 },
      end: { line: 1 },
      extra: { message: "x", severity: "LOW", fingerprint: "cloud-fp-123" },
    };
    expect(semgrepFingerprint(finding)).toBe("cloud-fp-123");
  });

  test("hashes rule, path, and lines when cloud fingerprint requires login", () => {
    const finding = {
      check_id: "example.rule",
      path: "src/a.ts",
      start: { line: 10 },
      end: { line: 12 },
      extra: { message: "x", severity: "LOW", fingerprint: "requires login" },
    };
    const a = semgrepFingerprint(finding);
    const b = semgrepFingerprint({ ...finding, start: { line: 11 } });
    expect(a).toHaveLength(40);
    expect(a).not.toBe(b);
    expect(semgrepFingerprint({ ...finding, extra: { message: "x", severity: "LOW" } })).toBe(a);
  });
});

function finding(path: string, line: number): SemgrepFinding {
  return {
    check_id: "example.rule",
    path,
    start: { line },
    end: { line },
    extra: {
      message: "Something risky",
      severity: "ERROR",
      metadata: { shortlink: "https://sg.run/x" },
      fingerprint: "requires login",
    },
  };
}

const revision = { repository: "acme/app", sha: "abc123" };

describe("formatFindingsSummary", () => {
  test("lists each finding with its rule and a link to the scanned line", () => {
    const summary = formatFindingsSummary([finding("src/routes/chat.tsx", 170)], revision);
    expect(summary).toBe(
      "## Semgrep findings on `abc123` (1)\n\n" +
        "| Severity | Rule | Location |\n| --- | --- | --- |\n" +
        "| ERROR | [`example.rule`](https://sg.run/x) | [`src/routes/chat.tsx:170`](https://github.com/acme/app/blob/abc123/src/routes/chat.tsx#L170) |\n",
    );
  });

  test("says so when the scan found nothing", () => {
    expect(formatFindingsSummary([], revision)).toBe(
      "## Semgrep findings on `abc123` (0)\n\nNo findings.\n",
    );
  });

  test("links to the GitHub server it is given, with each part of the path encoded", () => {
    const summary = formatFindingsSummary([finding("docs/Q&A #2/run me.sh", 3)], {
      ...revision,
      serverUrl: "https://github.example.com",
    });
    expect(summary).toContain(
      "[`docs/Q&A #2/run me.sh:3`](https://github.example.com/acme/app/blob/abc123/docs/Q%26A%20%232/run%20me.sh#L3)",
    );
  });

  test("leaves the rule unlinked when Semgrep gives no shortlink", () => {
    const { metadata: _, ...extra } = finding("src/a.ts", 1).extra;
    const summary = formatFindingsSummary([{ ...finding("src/a.ts", 1), extra }], revision);
    expect(summary).toContain("| ERROR | `example.rule` | ");
  });
});

describe("formatFindingsComment", () => {
  test("opens with the marker, then lists the findings and each one's message and fingerprint", () => {
    const found = finding("src/routes/chat.tsx", 170);
    expect(formatFindingsComment([found], revision)).toBe(
      `${COMMENT_MARKER}\n## Semgrep findings\n\n` +
        "1 finding(s) on `abc123`.\n\n" +
        "| Severity | Rule | Location |\n| --- | --- | --- |\n" +
        "| ERROR | [`example.rule`](https://sg.run/x) | [`src/routes/chat.tsx:170`](https://github.com/acme/app/blob/abc123/src/routes/chat.tsx#L170) |\n\n" +
        "### `example.rule` — `src/routes/chat.tsx:170`\n\n" +
        "Something risky\n\n" +
        "Rule link: https://sg.run/x\n\n" +
        `Fingerprint: \`${semgrepFingerprint(found)}\`\n`,
    );
  });

  test("says there are no new findings under the same marker, so it can replace an earlier list", () => {
    expect(formatFindingsComment([], revision)).toBe(
      `${COMMENT_MARKER}\n## Semgrep findings\n\nNo new findings on this revision.\n`,
    );
  });

  test("leaves the messages out of a comment that would pass GitHub's 65,536 characters", () => {
    const findings = Array.from({ length: 100 }, (_, index) => ({
      ...finding(`src/file-${index}.ts`, index + 1),
      extra: { message: "Explained at length. ".repeat(50), severity: "WARNING" },
    }));
    const comment = formatFindingsComment(findings, revision);
    expect(comment.length).toBeLessThanOrEqual(65_536);
    expect(comment.startsWith(`${COMMENT_MARKER}\n`)).toBe(true);
    expect(comment.match(/^\| WARNING \|/gm)).toHaveLength(100);
    expect(comment).not.toContain("Explained at length.");
    expect(comment).toMatch(
      /\n\nTheir messages are left out: GitHub limits a comment to 65,536 characters\.\n$/,
    );
  });

  test("lists only the rows that fit when even the table is too long, and says how many", () => {
    const findings = Array.from({ length: 1000 }, (_, index) =>
      finding(`src/a/rather/deeply/nested/directory/file-${index}.ts`, index + 1),
    );
    const comment = formatFindingsComment(findings, revision);
    expect(comment.length).toBeLessThanOrEqual(65_536);
    expect(comment).toContain("\n1000 finding(s) on `abc123`.\n");
    const listed = comment.match(/^\| ERROR \|/gm)?.length ?? 0;
    expect(listed).toBeGreaterThan(200);
    expect(listed).toBeLessThan(1000);
    expect(comment).toContain(`src/a/rather/deeply/nested/directory/file-${listed - 1}.ts:`);
    expect(comment).not.toContain(`src/a/rather/deeply/nested/directory/file-${listed}.ts:`);
    expect(comment).toMatch(
      new RegExp(
        `\\n\\nOnly the first ${listed} are listed, without their messages: GitHub limits a comment to 65,536 characters\\.\\n$`,
      ),
    );
  });
});

describe("parseFindings", () => {
  test("reads the results of semgrep scan --json", () => {
    const results = [finding("src/a.ts", 1)];
    expect(parseFindings(JSON.stringify({ version: "1.0.0", results, errors: [] }))).toEqual(
      results,
    );
  });

  test("rejects JSON without a results array", () => {
    expect(() => parseFindings('{"errors": []}')).toThrow(
      "Not the JSON output of semgrep scan: it has no results array",
    );
    expect(() => parseFindings("null")).toThrow("no results array");
  });
});
