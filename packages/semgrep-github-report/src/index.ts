/**
 * Formats the findings of `semgrep scan --json` for GitHub: as the pull request comment that later
 * runs find by its marker and update, or as a table for the job summary. These functions do no
 * I/O; the `semgrep-github-report` command (cli.ts) reads the findings and posts them.
 */

import { createHash } from "node:crypto";

/** Opens the pull request comment, so the next run finds it and updates it instead of adding one. */
export const COMMENT_MARKER = "<!-- semgrep-scan -->";

/** The longest comment body GitHub accepts. */
const COMMENT_MAX_LENGTH = 65_536;

/** One of the `results` of `semgrep scan --json`, with the fields this package reads. */
export interface SemgrepFinding {
  check_id: string;
  path: string;
  start: { line: number; col?: number };
  end: { line: number; col?: number };
  extra: {
    message: string;
    severity: string;
    metadata?: { shortlink?: string };
    /** "requires login" unless Semgrep is logged in (since Semgrep 1.98.0). */
    fingerprint?: string;
  };
}

/** The commit Semgrep scanned, where each finding links to its line. */
export interface Revision {
  /** `owner/name` */
  repository: string;
  /** The commit SHA. */
  sha: string;
  /** The GitHub server; `https://github.com` by default. GitHub Actions sets `GITHUB_SERVER_URL`. */
  serverUrl?: string;
}

/** The findings in the text `semgrep scan --json` writes. */
export const parseFindings = (json: string): SemgrepFinding[] => {
  // SAFETY: only `results` is read, and the check below is what decides whether it is usable.
  const report = JSON.parse(json) as { results?: unknown } | null;

  if (!Array.isArray(report?.results)) {
    // oxlint-disable-next-line unicorn/prefer-type-error -- the published error of this function is an Error, and callers match on its message
    throw new Error(
      "Not the JSON output of semgrep scan: it has no results array"
    );
  }

  // SAFETY: `semgrep scan --json` writes each result with the fields `SemgrepFinding` names, and
  // every read of them below tolerates a missing one.
  return report.results as SemgrepFinding[];
};

/**
 * Semgrep's fingerprint of the finding or, where `semgrep scan` without a login reports
 * "requires login", a hash of its rule, path and lines.
 */
export const semgrepFingerprint = (finding: SemgrepFinding): string => {
  const fromSemgrep = finding.extra.fingerprint;

  if (fromSemgrep && fromSemgrep !== "requires login") {
    return fromSemgrep;
  }

  const startLine = finding.start?.line ?? 0;
  const endLine = finding.end?.line ?? startLine;
  const payload = `${finding.check_id}\0${finding.path}\0${startLine}\0${endLine}`;

  return createHash("sha256").update(payload).digest("hex").slice(0, 40);
};

/**
 * `text` as Markdown that shows it as written, inside a code span or out of one: a zero-width
 * joiner after each `@`, `<` and `&` keeps GitHub from reading an `@` mention, which notifies, HTML
 * such as `<!--`, which can hide the rest of the comment, or a character reference such as `&#64;`,
 * which writes either. It shows nothing, where a backslash or `&lt;` would show inside a code span.
 */
const inertText = (text: string): string =>
  text.replaceAll(/[@<&]/gu, (character) => `${character}\u200D`);

/**
 * `text` as a Markdown code span. Its fence is one backtick longer than the longest run of
 * backticks in it, a space pads it where it starts or ends with a backtick or a space, and each
 * line break is a space, as a code span shows it anyway, so the span stays on its line.
 */
const codeSpan = (text: string): string => {
  const line = text.replaceAll(/\r\n?|\n/gu, " ");

  const longestRun = Math.max(
    0,
    ...(line.match(/`+/gu) ?? []).map((run) => run.length)
  );

  const fence = "`".repeat(longestRun + 1);
  const padding = /^[` ]|[` ]$/u.test(line) ? " " : "";

  return `${fence}${padding}${line}${padding}${fence}`;
};

/** A table cell's Markdown, with each `|` escaped so it does not end the cell, in a code span too. */
const tableCell = (markdown: string): string => markdown.replaceAll("|", "\\|");

const findingLocation = (finding: SemgrepFinding): string =>
  `${finding.path}:${finding.start.line}`;

const findingDocLink = (finding: SemgrepFinding): string | undefined =>
  finding.extra.metadata?.shortlink;

const findingCodeUrl = (
  finding: SemgrepFinding,
  revision: Revision
): string => {
  const server = revision.serverUrl ?? "https://github.com";
  const path = finding.path.split("/").map(encodeURIComponent).join("/");

  return `${server}/${revision.repository}/blob/${revision.sha}/${path}#L${finding.start.line}`;
};

const formatFindingRow = (
  finding: SemgrepFinding,
  revision: Revision
): string => {
  const doc = findingDocLink(finding);
  const rule = codeSpan(finding.check_id);
  const ruleCell = doc ? `[${rule}](${doc})` : rule;
  const locationCell = `[${codeSpan(findingLocation(finding))}](${findingCodeUrl(finding, revision)})`;
  const cells = [inertText(finding.extra.severity), ruleCell, locationCell];

  return `| ${cells.map(tableCell).join(" | ")} |`;
};

const formatFindingDetails = (finding: SemgrepFinding): string => {
  const doc = findingDocLink(finding);
  const docLine = doc ? `\n\nRule link: ${doc}` : "";
  const heading = `### ${codeSpan(finding.check_id)} — ${codeSpan(findingLocation(finding))}`;

  return `${heading}\n\n${inertText(finding.extra.message.trim())}${docLine}\n\nFingerprint: \`${semgrepFingerprint(finding)}\``;
};

const TABLE_HEADER = "| Severity | Rule | Location |\n| --- | --- | --- |\n";

/**
 * The pull request comment: a table of the findings, then each one's message and fingerprint, or
 * a line that says there are none. Where that is longer than GitHub accepts, the messages are left
 * out, then the rows that do not fit, and the last line says so.
 */
export const formatFindingsComment = (
  findings: SemgrepFinding[],
  revision: Revision
): string => {
  const header = `${COMMENT_MARKER}\n## Semgrep findings\n\n`;

  if (findings.length === 0) {
    return `${header}No new findings on this revision.\n`;
  }

  const intro = `${header}${findings.length} finding(s) on \`${revision.sha}\`.\n\n${TABLE_HEADER}`;
  const rows = findings.map((finding) => formatFindingRow(finding, revision));
  const comment = `${intro}${rows.join("\n")}\n\n${findings.map(formatFindingDetails).join("\n\n")}\n`;

  if (comment.length <= COMMENT_MAX_LENGTH) {
    return comment;
  }

  // The rows that fit beside the intro and the last line, which needs fewer than 200 characters.
  let length = intro.length + 200;
  let listed = 0;

  while (
    listed < rows.length &&
    length + rows[listed].length + 1 <= COMMENT_MAX_LENGTH
  ) {
    length += rows[listed].length + 1;
    listed += 1;
  }

  const note =
    listed === rows.length
      ? "Their messages are left out: GitHub limits a comment to 65,536 characters."
      : `Only the first ${listed} are listed, without their messages: GitHub limits a comment to 65,536 characters.`;

  return `${intro}${rows.slice(0, listed).join("\n")}\n\n${note}\n`;
};

/** A full scan's findings as a table for the job summary. */
export const formatFindingsSummary = (
  findings: SemgrepFinding[],
  revision: Revision
): string => {
  const header = `## Semgrep findings on \`${revision.sha}\` (${findings.length})\n\n`;

  if (findings.length === 0) {
    return `${header}No findings.\n`;
  }

  const rows = findings
    .map((finding) => formatFindingRow(finding, revision))
    .join("\n");

  return `${header}${TABLE_HEADER}${rows}\n`;
};
