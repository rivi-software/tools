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
export type SemgrepFinding = {
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
};

/** The commit Semgrep scanned, where each finding links to its line. */
export type Revision = {
  /** `owner/name` */
  repository: string;
  /** The commit SHA. */
  sha: string;
  /** The GitHub server; `https://github.com` by default. GitHub Actions sets `GITHUB_SERVER_URL`. */
  serverUrl?: string;
};

/** The findings in the text `semgrep scan --json` writes. */
export function parseFindings(json: string): SemgrepFinding[] {
  const report = JSON.parse(json) as { results?: unknown } | null;
  if (!Array.isArray(report?.results)) {
    throw new Error("Not the JSON output of semgrep scan: it has no results array");
  }
  return report.results as SemgrepFinding[];
}

/**
 * Semgrep's fingerprint of the finding or, where `semgrep scan` without a login reports
 * "requires login", a hash of its rule, path and lines.
 */
export function semgrepFingerprint(finding: SemgrepFinding): string {
  const fromSemgrep = finding.extra.fingerprint;
  if (fromSemgrep && fromSemgrep !== "requires login") {
    return fromSemgrep;
  }
  const startLine = finding.start?.line ?? 0;
  const endLine = finding.end?.line ?? startLine;
  const payload = `${finding.check_id}\0${finding.path}\0${startLine}\0${endLine}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 40);
}

function findingLocation(finding: SemgrepFinding): string {
  return `${finding.path}:${finding.start.line}`;
}

function findingDocLink(finding: SemgrepFinding): string | undefined {
  return finding.extra.metadata?.shortlink;
}

function findingCodeUrl(finding: SemgrepFinding, revision: Revision): string {
  const server = revision.serverUrl ?? "https://github.com";
  const path = finding.path.split("/").map(encodeURIComponent).join("/");
  return `${server}/${revision.repository}/blob/${revision.sha}/${path}#L${finding.start.line}`;
}

function formatFindingRow(finding: SemgrepFinding, revision: Revision): string {
  const doc = findingDocLink(finding);
  const ruleCell = doc ? `[\`${finding.check_id}\`](${doc})` : `\`${finding.check_id}\``;
  const locationCell = `[\`${findingLocation(finding)}\`](${findingCodeUrl(finding, revision)})`;
  return `| ${finding.extra.severity} | ${ruleCell} | ${locationCell} |`;
}

function formatFindingDetails(finding: SemgrepFinding): string {
  const doc = findingDocLink(finding);
  const docLine = doc ? `\n\nRule link: ${doc}` : "";
  return `### \`${finding.check_id}\` — \`${findingLocation(finding)}\`\n\n${finding.extra.message.trim()}${docLine}\n\nFingerprint: \`${semgrepFingerprint(finding)}\``;
}

const TABLE_HEADER = "| Severity | Rule | Location |\n| --- | --- | --- |\n";

/**
 * The pull request comment: a table of the findings, then each one's message and fingerprint, or
 * a line that says there are none. Where that is longer than GitHub accepts, the messages are left
 * out, then the rows that do not fit, and the last line says so.
 */
export function formatFindingsComment(findings: SemgrepFinding[], revision: Revision): string {
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
  while (listed < rows.length && length + rows[listed].length + 1 <= COMMENT_MAX_LENGTH) {
    length += rows[listed].length + 1;
    listed++;
  }
  const note =
    listed === rows.length
      ? "Their messages are left out: GitHub limits a comment to 65,536 characters."
      : `Only the first ${listed} are listed, without their messages: GitHub limits a comment to 65,536 characters.`;
  return `${intro}${rows.slice(0, listed).join("\n")}\n\n${note}\n`;
}

/** A full scan's findings as a table for the job summary. */
export function formatFindingsSummary(findings: SemgrepFinding[], revision: Revision): string {
  const header = `## Semgrep findings on \`${revision.sha}\` (${findings.length})\n\n`;
  if (findings.length === 0) {
    return `${header}No findings.\n`;
  }
  const rows = findings.map((finding) => formatFindingRow(finding, revision)).join("\n");
  return `${header}${TABLE_HEADER}${rows}\n`;
}
