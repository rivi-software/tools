/**
 * The `semgrep-github-report` command: reads the findings `semgrep scan --json` wrote, then creates
 * or updates the pull request's findings comment (`--mode pr`) or lists them in the job summary
 * (`--mode summary`). It takes what it needs from the environment GitHub Actions sets; cli.ts runs
 * it with the process's.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  COMMENT_MARKER,
  formatFindingsComment,
  formatFindingsSummary,
  parseFindings,
  type Revision,
  type SemgrepFinding,
} from "./index.js";

export const USAGE = `Usage: semgrep-github-report --mode pr|summary [options]

  --mode pr          create or update the pull request's findings comment (needs GITHUB_TOKEN)
  --mode summary     list the findings in the job summary, or print them outside GitHub Actions
  --findings <file>  the output of semgrep scan --json (default: semgrep-findings.json)
  --pr <number>      the pull request (default: the one in the pull_request event)
  --sha <commit>     the commit Semgrep scanned, which the links point at (default: GITHUB_SHA)
  -h, --help         show this help

It reads GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_EVENT_PATH, GITHUB_STEP_SUMMARY, GITHUB_API_URL
and GITHUB_SERVER_URL as GitHub Actions sets them.`;

// Follows GitHub's 403 when it refuses to create or update the comment.
const FORBIDDEN_HINT =
  "The token may not write comments here. The job needs `pull-requests: write`, and a pull request " +
  "from a fork gets a read-only token whatever the workflow asks for: list its findings with " +
  "--mode summary instead.";

type Env = Record<string, string | undefined>;

type Options = {
  mode: "pr" | "summary";
  findings: string;
  pr?: string;
  sha?: string;
};

type IssueComment = { id: number; body?: string; html_url?: string };

type GitHub = { apiUrl: string; token: string };

/** The command's options, or undefined when it is asked for its help. */
function parseOptions(argv: string[]): Options | undefined {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        mode: { type: "string" },
        findings: { type: "string", default: "semgrep-findings.json" },
        pr: { type: "string" },
        sha: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    throw new Error(`${(error as Error).message}\n\n${USAGE}`);
  }
  const { mode, findings, pr, sha, help } = values;
  if (help) {
    return undefined;
  }
  if (mode !== "pr" && mode !== "summary") {
    throw new Error(`Invalid --mode ${mode ?? "(missing)"}\n\n${USAGE}`);
  }
  return { mode, findings, pr, sha };
}

function requireEnv(env: Env, name: string, option?: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}${option ? ` (or pass ${option})` : ""}`,
    );
  }
  return value;
}

function loadFindings(path: string): SemgrepFinding[] {
  try {
    return parseFindings(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Semgrep findings from ${path}: ${(error as Error).message}`);
  }
}

/** `--pr`, or else the pull request of the event that started the workflow. */
function pullRequestNumber(option: string | undefined, env: Env): number {
  let value: unknown = option;
  if (value === undefined && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
      pull_request?: { number?: unknown };
    };
    value = event.pull_request?.number;
  }
  if (value === undefined) {
    throw new Error("No pull request: pass --pr <number>, or run on a pull_request event");
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid pull request number: ${String(value)}`);
  }
  return number;
}

async function githubJson<T>(
  github: GitHub,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${github.apiUrl}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${github.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error: Error) => {
    // fetch says only "fetch failed"; why, such as ECONNREFUSED, is in its cause.
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    throw new Error(`GitHub API ${method} ${url}: ${error.message}${cause}`);
  });
  if (!response.ok) {
    const hint = response.status === 403 && method !== "GET" ? `\n${FORBIDDEN_HINT}` : "";
    throw new Error(
      `GitHub API ${response.status} ${method} ${path}: ${await response.text()}${hint}`,
    );
  }
  return (await response.json()) as T;
}

/** The first comment on the pull request that carries the marker, looking 100 at a time. */
async function findSemgrepPrComment(
  github: GitHub,
  repo: string,
  prNumber: number,
): Promise<IssueComment | undefined> {
  for (let page = 1; ; page++) {
    const comments = await githubJson<IssueComment[]>(
      github,
      "GET",
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    const comment = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
    if (comment || comments.length < 100) {
      return comment;
    }
  }
}

/** Runs the command with these arguments and environment; resolves to what it prints. */
export async function main(argv: string[], env: Env): Promise<string> {
  const options = parseOptions(argv);
  if (!options) {
    return USAGE;
  }
  const repo = requireEnv(env, "GITHUB_REPOSITORY");
  const revision: Revision = {
    repository: repo,
    sha: options.sha || requireEnv(env, "GITHUB_SHA", "--sha <commit>"),
    serverUrl: env.GITHUB_SERVER_URL || undefined,
  };
  const findings = loadFindings(options.findings);

  if (options.mode === "summary") {
    const summary = formatFindingsSummary(findings, revision);
    if (!env.GITHUB_STEP_SUMMARY) {
      return summary;
    }
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    return `Listed ${findings.length} finding(s) in the job summary.`;
  }

  const github = {
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    token: requireEnv(env, "GITHUB_TOKEN"),
  };
  const prNumber = pullRequestNumber(options.pr, env);
  const body = formatFindingsComment(findings, revision);
  // A pull request without findings gets no comment, but one it already has says they are gone.
  const existing = await findSemgrepPrComment(github, repo, prNumber);
  if (existing) {
    const updated = await githubJson<IssueComment>(
      github,
      "PATCH",
      `/repos/${repo}/issues/comments/${existing.id}`,
      { body },
    );
    return `Updated ${updated.html_url} with ${findings.length} finding(s).`;
  }
  if (findings.length === 0) {
    return `No findings, and no comment on #${prNumber} to update.`;
  }
  const created = await githubJson<IssueComment>(
    github,
    "POST",
    `/repos/${repo}/issues/${prNumber}/comments`,
    { body },
  );
  return `Commented ${created.html_url} with ${findings.length} finding(s).`;
}
