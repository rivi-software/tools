/**
 * Drafts the next rivi-bot release (.github/workflows/rivi-bot-release.yml): a GitHub release of a
 * `rivi-bot-v*` tag on a commit of main, not published yet. A maintainer then rewrites the notes
 * and publishes the release, which creates the tag. planRelease in scripts/rivi-bot-release.ts
 * makes every check and picks the version; this script gives it git and the GitHub API, and drafts
 * what it returns.
 *
 * Needs GITHUB_TOKEN (contents: write and actions: read), GITHUB_REPOSITORY, a clone with main's
 * history and tags, and BUMP: `auto` to read the part to raise from the Conventional Commits
 * titles, or `major`, `minor` or `patch`. COMMIT names a commit other than the head of main.
 *   git fetch origin main --tags
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=rivi-software/tools BUMP=auto \
 *     node scripts/release-rivi-bot.ts --dry-run    says what it would draft, and drafts nothing
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { parseTag, planRelease, RIVI_BOT_PATHS } from "./rivi-bot-release.ts";
import type { ReleasePlan, ReleaseSource } from "./rivi-bot-release.ts";

const { env } = process;
const dryRun = process.argv.includes("--dry-run");

interface WorkflowRun {
  html_url: string;
  status: string;
  conclusion: string | null;
}

interface Release {
  tag_name: string;
  draft: boolean;
  html_url: string;
}

/** What this script sends GitHub: the release it drafts. */
interface NewRelease {
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  draft: true;
}

const github = async <T>(
  method: string,
  path: string,
  body?: NewRelease
): Promise<T> => {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`,
    {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub ${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  // SAFETY: GitHub answers each of these endpoints with the JSON the caller asks for.
  return (await response.json()) as T;
};

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf-8" }).trim();

/** Runs git and returns its exit status and output, rather than throw when it exits non-zero. */
const gitStatus = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf-8" });

  if (result.error) {
    throw result.error;
  }

  return result;
};

const source: ReleaseSource = {
  // `rev-parse --verify --quiet` prints nothing, and exits 1, for a name that is no commit.
  resolve: (commit) => {
    const result = gitStatus(
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${commit}^{commit}`
    );

    return result.status === 0 ? result.stdout.trim() : undefined;
  },
  // `merge-base --is-ancestor` exits 1 for "no", and with another status when it cannot tell, such
  // as for a commit or a tag the clone lacks: that throws, with git's own message.
  isAncestor: (ancestor, commit) => {
    const result = gitStatus("merge-base", "--is-ancestor", ancestor, commit);

    if (result.status === 0 || result.status === 1) {
      return result.status === 0;
    }

    throw new Error(
      `git merge-base --is-ancestor ${ancestor} ${commit} failed: ${result.stderr.trim()}. Fetch main and its tags first: git fetch origin main --tags`
    );
  },
  tags: () => git("tag", "--list", "rivi-bot-v*").split("\n"),
  commits: (from, to) =>
    git("log", "--format=%H%x09%s", `${from}..${to}`, "--", ...RIVI_BOT_PATHS)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split("\t");

        return { sha, subject: subject.join("\t") };
      }),
  ciRun: async (sha) => {
    const { workflow_runs: runs } = await github<{
      workflow_runs: WorkflowRun[];
    }>(
      "GET",
      `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=1`
    );

    const [run] = runs;

    return (
      run && {
        url: run.html_url,
        status: run.status,
        conclusion: run.conclusion,
      }
    );
  },
  waitingDraft: async () => {
    for (let page = 1; ; page += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a page tells whether there is another
      const releases = await github<Release[]>(
        "GET",
        `/releases?per_page=100&page=${page}`
      );

      const draft = releases.find(
        (release) => release.draft && parseTag(release.tag_name)
      );

      if (draft || releases.length < 100) {
        return draft && { tag: draft.tag_name, url: draft.html_url };
      }
    }
  },
};

/** What the run did, as Markdown for the job summary. */
const summaryFor = (plan: ReleasePlan, draftUrl: string | undefined): string =>
  [
    `## ${plan.tag}${draftUrl ? "" : " (dry run)"}`,
    "",
    draftUrl
      ? `[The draft](${draftUrl}) releases \`${plan.sha}\`, ${plan.commits.length} commit(s) after ${plan.last}.`
      : `A run without --dry-run drafts ${plan.tag} on \`${plan.sha}\`, ${plan.commits.length} commit(s) after ${plan.last}.`,
    "",
    `- The version raises the ${plan.bump} part, as ${plan.requested === "auto" ? "the commit titles call for" : "the run asked"}.`,
    `- [CI passed](${plan.ci}) on the commit.`,
    ...plan.warnings.map((warning) => `- ${warning}`),
    "",
    'Before publishing, rewrite the notes for the people who run rivi-bot (CONTRIBUTING.md, "A rivi-bot release"): what changed for them, a Security section that names the advisory of a security fix, and under Upgrading what a caller has to do. Publishing creates the tag, which is never moved or deleted.',
    "",
    "### Draft notes",
    "",
    plan.notes,
  ].join("\n");

for (const name of ["GITHUB_TOKEN", "GITHUB_REPOSITORY"]) {
  if (!env[name]) {
    console.log(`::error title=rivi-bot release::Set ${name}.`);
    process.exit(1);
  }
}

try {
  const plan = await planRelease(
    { bump: env.BUMP, commit: env.COMMIT, ref: env.GITHUB_REF },
    source
  );

  for (const warning of plan.warnings) {
    console.log(`::warning title=rivi-bot release::${warning}`);
  }

  const draft = dryRun
    ? undefined
    : await github<Release>("POST", "/releases", {
        tag_name: plan.tag,
        target_commitish: plan.sha,
        name: plan.tag,
        body: plan.notes,
        draft: true,
      });

  const summary = summaryFor(plan, draft?.html_url);

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  console.log(summary);
} catch (error) {
  // SAFETY: fetch, git and planRelease throw Errors.
  console.log(
    `::error title=rivi-bot release::${(error as Error).message.replaceAll("%", "%25")}`
  );
  process.exit(1);
}
