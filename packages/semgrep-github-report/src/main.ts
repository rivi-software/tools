/**
 * The `semgrep-github-report` command: reads the findings `semgrep scan --json` wrote, then creates
 * or updates the pull request's findings comment (`--mode pr`) or lists them in the job summary
 * (`--mode summary`, and `--mode pr` on a pull request from a fork, whose token cannot comment). It
 * takes what it needs from the environment GitHub Actions sets; cli.ts runs it with the process's.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  COMMENT_MARKER,
  formatFindingsComment,
  formatFindingsSummary,
  parseFindings,
} from "./index.js";
import type { Revision, SemgrepFinding } from "./index.js";

export const USAGE = `Usage: semgrep-github-report --mode pr|summary [options]

  --mode pr          create or update the pull request's findings comment (needs GITHUB_TOKEN),
                     or list them in the job summary when the pull request comes from a fork
  --mode summary     list the findings in the job summary, or print them outside GitHub Actions
  --findings <file>  the output of semgrep scan --json (default: semgrep-findings.json)
  --pr <number>      the pull request (default: the one in the pull_request event)
  --sha <commit>     the commit Semgrep scanned, which the links point at (default: GITHUB_SHA)
  --author <login>   the account GITHUB_TOKEN comments as (default: github-actions[bot])
  -h, --help         show this help

It reads GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_EVENT_PATH, GITHUB_STEP_SUMMARY, GITHUB_API_URL
and GITHUB_SERVER_URL as GitHub Actions sets them.`;

// Follows GitHub's 403 when it refuses to create or update the comment. A pull request from a fork
// never gets here: the command lists its findings in the job summary instead.
const FORBIDDEN_HINT =
  "The token may not write comments here: the job needs `pull-requests: write`.";

/** The account a job's GITHUB_TOKEN comments as. */
const GITHUB_ACTIONS_LOGIN = "github-actions[bot]";

type Env = Record<string, string | undefined>;

interface Options {
  mode: "pr" | "summary";
  findings: string;
  pr?: string;
  sha?: string;
  author: string;
}

interface IssueComment {
  id: number;
  body?: string;
  html_url?: string;
  /** null for a deleted account. */
  user?: { login?: string } | null;
}

interface GitHub {
  apiUrl: string;
  token: string;
}

/** The JSON a request carries, which is only ever the body of the findings comment. */
interface CommentBody {
  body: string;
}

/** The command's options, or undefined when it is asked for its help. */
const parseOptions = (argv: string[]): Options | undefined => {
  let values;

  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        mode: { type: "string" },
        findings: { type: "string", default: "semgrep-findings.json" },
        pr: { type: "string" },
        sha: { type: "string" },
        author: { type: "string", default: GITHUB_ACTIONS_LOGIN },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    // SAFETY: parseArgs throws an Error for an option it cannot read.
    throw new Error(`${(error as Error).message}\n\n${USAGE}`, {
      cause: error,
    });
  }

  const { mode, findings, pr, sha, author, help } = values;

  if (help) {
    return undefined;
  }

  if (mode !== "pr" && mode !== "summary") {
    throw new Error(`Invalid --mode ${mode ?? "(missing)"}\n\n${USAGE}`);
  }

  // A workflow that passes an unset variable would otherwise add a comment on every run. Only
  // --mode pr reads it, so a summary step that shares the variable still runs.
  if (mode === "pr" && !author) {
    throw new Error(`Invalid --author: an empty login\n\n${USAGE}`);
  }

  return { mode, findings, pr, sha, author };
};

const requireEnv = (env: Env, name: string, option?: string): string => {
  const value = env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}${option ? ` (or pass ${option})` : ""}`
    );
  }

  return value;
};

const loadFindings = (path: string): SemgrepFinding[] => {
  try {
    return parseFindings(readFileSync(path, "utf-8"));
  } catch (error) {
    // SAFETY: readFileSync, JSON.parse and parseFindings each throw an Error.
    throw new Error(
      `Cannot read Semgrep findings from ${path}: ${(error as Error).message}`,
      { cause: error }
    );
  }
};

/** The fields of the event that started the workflow that the command reads. */
interface WorkflowEvent {
  pull_request?: {
    number?: unknown;
    /** `repo` is null once the fork is deleted. */
    head?: { repo?: { full_name?: unknown } | null };
  };
}

/**
 * The event in `GITHUB_EVENT_PATH`, or an empty one outside GitHub Actions. `--mode pr` reads it
 * with `--pr` too, since a pull request from a fork gets the job summary whoever names it.
 */
const readEvent = (env: Env): WorkflowEvent => {
  const path = env.GITHUB_EVENT_PATH;

  if (!path) {
    return {};
  }

  try {
    // SAFETY: GitHub Actions writes the event as JSON, and each read of it checks what it finds.
    return JSON.parse(readFileSync(path, "utf-8")) as WorkflowEvent;
  } catch (error) {
    // SAFETY: readFileSync and JSON.parse each throw an Error.
    throw new Error(
      `Cannot read the workflow event from ${path} (GITHUB_EVENT_PATH): ${(error as Error).message}`,
      { cause: error }
    );
  }
};

/**
 * Whether the event is a pull request from another repository, or from a fork since deleted. By
 * default, GitHub gives the `pull_request` workflows such a pull request starts a read-only
 * `GITHUB_TOKEN`.
 */
const comesFromFork = (event: WorkflowEvent, repo: string): boolean => {
  const head = event.pull_request?.head;

  return head !== undefined && head.repo?.full_name !== repo;
};

/** `--pr`, or else the pull request of the event that started the workflow. */
const pullRequestNumber = (
  option: string | undefined,
  event: WorkflowEvent
): number => {
  const value = option ?? event.pull_request?.number;

  if (value === undefined) {
    throw new Error(
      "No pull request: pass --pr <number>, or run on a pull_request event"
    );
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid pull request number: ${String(value)}`);
  }

  return number;
};

const githubJson = async <T>(
  github: GitHub,
  method: string,
  path: string,
  body?: CommentBody
): Promise<T> => {
  const url = `${github.apiUrl}${path}`;

  const headers = new Headers({
    Authorization: `Bearer ${github.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error: Error) => {
    // fetch says only "fetch failed"; why, such as ECONNREFUSED, is in its cause.
    const cause =
      error.cause instanceof Error ? ` (${error.cause.message})` : "";

    throw new Error(`GitHub API ${method} ${url}: ${error.message}${cause}`);
  });

  if (!response.ok) {
    const hint =
      response.status === 403 && method !== "GET" ? `\n${FORBIDDEN_HINT}` : "";

    throw new Error(
      `GitHub API ${response.status} ${method} ${path}: ${await response.text()}${hint}`
    );
  }

  // SAFETY: each caller names the type GitHub's REST API answers for the path it asks for.
  return (await response.json()) as T;
};

/**
 * The first comment on the pull request that `author` wrote and that opens with the marker,
 * looking 100 at a time. A comment that quotes or pastes the report is someone else's, or holds
 * the marker further in, and is left alone. GitHub matches logins in any case, so this does too.
 */
const findSemgrepPrComment = async (
  github: GitHub,
  repo: string,
  prNumber: number,
  author: string
): Promise<IssueComment | undefined> => {
  const login = author.toLowerCase();

  for (let page = 1; ; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page is asked for only when the one before it was full
    const comments = await githubJson<IssueComment[]>(
      github,
      "GET",
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`
    );

    const ours = comments.find(
      (comment) =>
        comment.user?.login?.toLowerCase() === login &&
        comment.body?.startsWith(COMMENT_MARKER)
    );

    if (ours || comments.length < 100) {
      return ours;
    }
  }
};

/** Appends the findings to the job summary, or returns them outside GitHub Actions. */
const listInSummary = (
  findings: SemgrepFinding[],
  revision: Revision,
  env: Env
): string => {
  const summary = formatFindingsSummary(findings, revision);

  if (!env.GITHUB_STEP_SUMMARY) {
    return summary;
  }

  appendFileSync(env.GITHUB_STEP_SUMMARY, summary);

  return `Listed ${findings.length} finding(s) in the job summary.`;
};

/** Runs the command with these arguments and environment; resolves to what it prints. */
export const main = async (argv: string[], env: Env): Promise<string> => {
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
    return listInSummary(findings, revision, env);
  }

  const event = readEvent(env);
  const prNumber = pullRequestNumber(options.pr, event);

  if (comesFromFork(event, repo)) {
    const why = `Pull request #${prNumber} comes from a fork: listing its findings in the job summary instead of a comment.`;

    return `${why}\n${listInSummary(findings, revision, env)}`;
  }

  const github = {
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    token: requireEnv(env, "GITHUB_TOKEN"),
  };

  const body = formatFindingsComment(findings, revision);

  // A pull request without findings gets no comment, but one it already has says they are gone.
  const existing = await findSemgrepPrComment(
    github,
    repo,
    prNumber,
    options.author
  );

  if (existing) {
    const updated = await githubJson<IssueComment>(
      github,
      "PATCH",
      `/repos/${repo}/issues/comments/${existing.id}`,
      { body }
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
    { body }
  );

  return `Commented ${created.html_url} with ${findings.length} finding(s).`;
};
