/**
 * Checks that a pull request which changes what a package publishes comes with a changeset that
 * names the package (.github/workflows/changeset.yml). checkChangesets in
 * scripts/changeset-rules.ts makes the check; this script gives it git.
 *
 * It compares the head with the commit where it branched from the base, so it reads a branch's
 * commits, not uncommitted changes. LABELS holds the pull request's labels as a JSON array of
 * names, as the workflow's `toJSON` writes them.
 *   git fetch origin main
 *   node scripts/check-changeset.ts [base] [head]    origin/main and HEAD by default
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import {
  checkChangesets,
  describeRelease,
  isChangeset,
  packageDirectories,
  parseNameStatus,
  passes,
  report,
} from "./changeset-rules.ts";
import type { Manifest, ManifestPair } from "./changeset-rules.ts";

const { env } = process;
const [base = "origin/main", head = "HEAD"] = process.argv.slice(2);

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

/** A file's content at a commit, or undefined when the commit has no such file. */
const fileAt = (commit: string, path: string): string | undefined =>
  git("ls-tree", "--name-only", commit, "--", path).trim()
    ? git("show", `${commit}:${path}`)
    : undefined;

const manifestAt = (commit: string, path: string): Manifest | undefined => {
  const text = fileAt(commit, path);

  // SAFETY: check:manifests holds every package.json to the fields Manifest names.
  return text === undefined ? undefined : (JSON.parse(text) as Manifest);
};

// SAFETY: the workflow writes LABELS with toJSON, from the names of the pull request's labels.
const labels = JSON.parse(env.LABELS || "[]") as string[];

/** Escapes a workflow command's message, which ends at a line break. */
const escapeCommand = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const start = git("merge-base", base, head).trim();

const files = parseNameStatus(
  git("diff", "--name-status", "--no-renames", "-z", start, head)
);

const manifests: Record<string, ManifestPair> = Object.fromEntries(
  packageDirectories(files).map((directory) => {
    const path = `packages/${directory}/package.json`;

    return [
      directory,
      { base: manifestAt(start, path), head: manifestAt(head, path) },
    ];
  })
);

const changesets: Record<string, string> = Object.fromEntries(
  files.flatMap(({ path, status }) => {
    const text =
      isChangeset(path) && status !== "deleted"
        ? fileAt(head, path)
        : undefined;

    return text === undefined ? [] : [[path, text]];
  })
);

const verdict = checkChangesets({ files, manifests, changesets, labels });

const summary = report(verdict);

console.log(summary);

if (env.GITHUB_STEP_SUMMARY) {
  appendFileSync(env.GITHUB_STEP_SUMMARY, `## Changeset\n\n${summary}\n`);
}

if (env.GITHUB_ACTIONS === "true") {
  const level = verdict.waived ? "notice" : "error";

  for (const release of verdict.missing) {
    console.log(
      `::${level} title=Changeset for ${release.name}::${escapeCommand(`The pull request changes ${describeRelease(release)}, and no changeset names ${release.name}.`)}`
    );
  }
}

if (!passes(verdict)) {
  process.exitCode = 1;
}
