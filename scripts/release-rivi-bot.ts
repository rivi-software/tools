/**
 * Drafts the next rivi-bot release (.github/workflows/rivi-bot-release.yml): a GitHub release of a
 * `rivi-bot-v*` tag on a commit of main, not published yet. It checks that the commit is on main,
 * that it comes after the last release and changes rivi-bot, that CI passed on it, and that no
 * other rivi-bot release waits as a draft. A maintainer then rewrites the notes and publishes the
 * release, which creates the tag. scripts/rivi-bot-release.ts picks the version and writes the
 * notes.
 *
 * Needs GITHUB_TOKEN (contents: write and actions: read), GITHUB_REPOSITORY, a clone with main's
 * history and tags, and BUMP: `auto` to read the part to raise from the Conventional Commits
 * titles, or `major`, `minor` or `patch`. COMMIT names a commit other than the head of main.
 *   git fetch origin main --tags
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=rivi-software/tools BUMP=auto \
 *     node scripts/release-rivi-bot.ts --dry-run    says what it would draft, and drafts nothing
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import {
  bumpForAll,
  isHigher,
  latestTag,
  nextVersion,
  parseTag,
  releaseNotes,
  RIVI_BOT_PATHS,
  tagFor,
} from "./rivi-bot-release.ts";
import type { Bump, Commit } from "./rivi-bot-release.ts";

const { env } = process;
const dryRun = process.argv.includes("--dry-run");
const MAIN = "origin/main";

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

/** Whether `ancestor` is `commit` or comes before it. */
const isAncestor = (ancestor: string, commit: string): boolean => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, commit]);

    return true;
  } catch {
    return false;
  }
};

/** The full SHA of the commit to release: COMMIT, or the head of main. */
const targetCommit = (): string => {
  const commit = env.COMMIT?.trim() || MAIN;

  if (commit !== MAIN && !/^[\da-f]{7,40}$/iu.test(commit)) {
    throw new Error(`COMMIT is not a commit SHA: ${commit}`);
  }

  try {
    return git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${commit}^{commit}`
    );
  } catch {
    throw new Error(
      `${commit} is not a commit in this clone. Fetch main first: git fetch origin main --tags`
    );
  }
};

/** CI's last run on the commit as a push to main: it has to have passed. */
const checkCi = async (sha: string): Promise<string> => {
  const { workflow_runs: runs } = await github<{
    workflow_runs: WorkflowRun[];
  }>(
    "GET",
    `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=1`
  );

  const [run] = runs;

  if (!run) {
    throw new Error(`CI has not run on ${sha} as a push to main.`);
  }

  if (run.status !== "completed") {
    throw new Error(
      `CI is still running on ${sha}: ${run.html_url}. Run this again once it passes.`
    );
  }

  if (run.conclusion !== "success") {
    throw new Error(
      `CI ended as ${run.conclusion} on ${sha}: ${run.html_url}. Re-run it, and run this again once it passes.`
    );
  }

  return run.html_url;
};

/** A rivi-bot release that waits as a draft, which a new one would compete with. */
const waitingDraft = async (): Promise<Release | undefined> => {
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
      return draft;
    }
  }
};

const isBump = (value: string | undefined): value is Bump | "auto" =>
  value === "auto" ||
  value === "major" ||
  value === "minor" ||
  value === "patch";

/** What it did, as Markdown for the job summary. */
const draftRelease = async (): Promise<string> => {
  const { BUMP: requested } = env;

  if (!isBump(requested)) {
    throw new Error(
      `BUMP is ${requested ?? "unset"}: set it to auto, major, minor or patch.`
    );
  }

  // A run from another branch would run that branch's copy of this script.
  if (env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main") {
    throw new Error(`Run the workflow from main, not ${env.GITHUB_REF}.`);
  }

  const sha = targetCommit();

  if (!isAncestor(sha, MAIN)) {
    throw new Error(`${sha} is not on main.`);
  }

  const last = latestTag(git("tag", "--list", "rivi-bot-v*").split("\n"));
  const lastVersion = last && parseTag(last);

  if (!last || !lastVersion) {
    throw new Error(
      "There is no rivi-bot-v* tag to follow. Fetch the tags first: git fetch origin main --tags"
    );
  }

  if (!isAncestor(last, sha)) {
    throw new Error(
      `${sha} comes before ${last}, or beside it: a release follows the last one.`
    );
  }

  const commits: Commit[] = git(
    "log",
    "--format=%H%x09%s",
    `${last}..${sha}`,
    "--",
    ...RIVI_BOT_PATHS
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, ...subject] = line.split("\t");

      return { sha: hash, subject: subject.join("\t") };
    });

  if (commits.length === 0) {
    throw new Error(
      `Nothing in ${RIVI_BOT_PATHS.join(" or ")} changed between ${last} and ${sha}.`
    );
  }

  const fromTitles = bumpForAll(commits);
  const bump = requested === "auto" ? fromTitles : requested;
  const tag = tagFor(nextVersion(lastVersion, bump));
  const notes = releaseNotes({ tag, sha, commits });
  const warnings: string[] = [];

  if (isHigher(fromTitles, bump)) {
    warnings.push(
      `The commit titles call for a ${fromTitles} release, and the run asked for ${bump}. Check that no change needs a caller to act.`
    );
  }

  const ci = await checkCi(sha);
  const draft = await waitingDraft();

  if (draft) {
    throw new Error(
      `${draft.tag_name} waits as a draft: ${draft.html_url}. Publish or delete it, then run this again.`
    );
  }

  for (const warning of warnings) {
    console.log(`::warning title=rivi-bot release::${warning}`);
  }

  const release = dryRun
    ? undefined
    : await github<Release>("POST", "/releases", {
        tag_name: tag,
        target_commitish: sha,
        name: tag,
        body: notes,
        draft: true,
      });

  return [
    `## ${tag}${dryRun ? " (dry run)" : ""}`,
    "",
    release
      ? `[The draft](${release.html_url}) releases \`${sha}\`, ${commits.length} commit(s) after ${last}.`
      : `A run without --dry-run drafts ${tag} on \`${sha}\`, ${commits.length} commit(s) after ${last}.`,
    "",
    `- The version raises the ${bump} part, as ${requested === "auto" ? "the commit titles call for" : "the run asked"}.`,
    `- [CI passed](${ci}) on the commit.`,
    ...warnings.map((warning) => `- ${warning}`),
    "",
    'Before publishing, rewrite the notes for the people who run rivi-bot (CONTRIBUTING.md, "A rivi-bot release"): what changed for them, a Security section that names the advisory of a security fix, and under Upgrading what a caller has to do. Publishing creates the tag, which is never moved or deleted.',
    "",
    "### Draft notes",
    "",
    notes,
  ].join("\n");
};

for (const name of ["GITHUB_TOKEN", "GITHUB_REPOSITORY"]) {
  if (!env[name]) {
    console.log(`::error title=rivi-bot release::Set ${name}.`);
    process.exit(1);
  }
}

try {
  const summary = await draftRelease();

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  console.log(summary);
} catch (error) {
  // SAFETY: fetch, git and this script throw Errors.
  console.log(
    `::error title=rivi-bot release::${(error as Error).message.replaceAll("%", "%25")}`
  );
  process.exit(1);
}
