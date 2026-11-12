/**
 * The next rivi-bot release that scripts/release-rivi-bot.ts drafts: the checks that rule one out,
 * its version and its notes. A version is a `rivi-bot-v<major>.<minor>.<patch>` tag, and
 * CONTRIBUTING.md ("A rivi-bot release") says which part a change raises.
 */

/** What a rivi-bot release holds: the actions and the reusable workflow. */
export const RIVI_BOT_PATHS = [
  "rivi-bot",
  ".github/workflows/rivi-bot.yml",
] as const;

export type Bump = "major" | "minor" | "patch";

export type Version = readonly [major: number, minor: number, patch: number];

/** A commit on main since the last release, newest first as `git log` lists them. */
export interface Commit {
  sha: string;
  subject: string;
}

const TAG =
  /^rivi-bot-v(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;

/** A Conventional Commits title: a type, an optional scope, an optional `!`, then the description. */
const CONVENTIONAL =
  /^(?<type>[a-z]+)(?:\([^()]*\))?(?<breaking>!)?: (?<description>.+)$/u;

const BUMPS: readonly Bump[] = ["patch", "minor", "major"];

/** The version a rivi-bot tag names, or undefined for any other tag. */
export const parseTag = (tag: string): Version | undefined => {
  const groups = TAG.exec(tag)?.groups;

  return groups
    ? [Number(groups.major), Number(groups.minor), Number(groups.patch)]
    : undefined;
};

export const tagFor = (version: Version): string =>
  `rivi-bot-v${version.join(".")}`;

const compareVersions = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The rivi-bot tag with the highest version, or undefined when there is none. */
export const latestTag = (tags: readonly string[]): string | undefined => {
  let latest: { tag: string; version: Version } | undefined;

  for (const tag of tags) {
    const version = parseTag(tag);

    if (version && (!latest || compareVersions(version, latest.version) > 0)) {
      latest = { tag, version };
    }
  }

  return latest?.tag;
};

/**
 * The part a commit raises, by its Conventional Commits title: major for a breaking change (`!`),
 * minor for a `feat`, patch for anything else, a title in another form included.
 */
export const bumpFor = (subject: string): Bump => {
  const groups = CONVENTIONAL.exec(subject)?.groups;

  if (groups?.breaking) {
    return "major";
  }

  return groups?.type === "feat" ? "minor" : "patch";
};

/** Whether `a` raises a higher part of the version than `b`. */
export const isHigher = (a: Bump, b: Bump): boolean =>
  BUMPS.indexOf(a) > BUMPS.indexOf(b);

/** The highest part any of the commits raises. */
export const bumpForAll = (commits: readonly Commit[]): Bump => {
  let highest: Bump = "patch";

  for (const { subject } of commits) {
    const bump = bumpFor(subject);

    if (isHigher(bump, highest)) {
      highest = bump;
    }
  }

  return highest;
};

export const nextVersion = (
  [major, minor, patch]: Version,
  bump: Bump
): Version => {
  if (bump === "major") {
    return [major + 1, 0, 0];
  }

  return bump === "minor" ? [major, minor + 1, 0] : [major, minor, patch + 1];
};

/**
 * A commit as one bullet: its description, without the Conventional Commits type, and its pull
 * request, which a squash merge's title ends with. A commit without one, such as a security
 * advisory's merge, keeps its whole title and gets its short SHA, which GitHub links.
 */
const bullet = ({ sha, subject }: Commit): string => {
  const description =
    CONVENTIONAL.exec(subject)?.groups?.description ?? subject;

  const text = `${description.charAt(0).toUpperCase()}${description.slice(1)}`;

  return /\(#\d+\)$/u.test(text)
    ? `- ${text}.`
    : `- ${text} (${sha.slice(0, 7)}).`;
};

/**
 * The draft notes, in the shape of rivi-bot-v1.0.0's: how to pin the release, then the commits
 * since the last one, oldest first. A breaking change goes under Upgrading, where the notes say
 * what a caller has to do; everything else goes under Changes. A maintainer rewrites them for the
 * people who run rivi-bot before publishing, and adds Security for a security fix.
 */
export const releaseNotes = ({
  tag,
  sha,
  commits,
}: {
  tag: string;
  sha: string;
  commits: readonly Commit[];
}): string => {
  const oldestFirst = commits.toReversed();

  const breaking = oldestFirst.filter(
    ({ subject }) => bumpFor(subject) === "major"
  );

  const rest = oldestFirst.filter(
    ({ subject }) => bumpFor(subject) !== "major"
  );

  const sections = [
    `Pin to this tag, such as \`rivi-software/tools/rivi-bot@${tag}\` or \`rivi-software/tools/rivi-bot/triage@${tag}\` for an action and \`rivi-software/tools/.github/workflows/rivi-bot.yml@${tag}\` for the reusable workflow, or to its commit, \`${sha}\`.`,
  ];

  if (rest.length > 0) {
    sections.push(`### Changes\n\n${rest.map(bullet).join("\n")}`);
  }

  if (breaking.length > 0) {
    sections.push(`### Upgrading\n\n${breaking.map(bullet).join("\n")}`);
  }

  return `${sections.join("\n\n")}\n`;
};

/** The ref of main's head in the clone. */
export const MAIN = "origin/main";

export type Requested = Bump | "auto";

/**
 * The check a release waits for: the one main's ruleset requires (.github/rulesets/main.json),
 * which Depot CI's `verify` job reports through the Depot Code Access app once every other job
 * has finished.
 */
export const CI_CHECK = { name: "CI / verify", appId: 219_785 } as const;

/** A check run on a commit, as GitHub reports it. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

/** A rivi-bot release that waits as a draft. */
export interface Draft {
  tag: string;
  url: string;
}

/**
 * What planRelease reads from the clone and from GitHub: git and the API in
 * scripts/release-rivi-bot.ts, a fake in the tests.
 */
export interface ReleaseSource {
  /** The full SHA of a commit, `MAIN` included, or undefined when the clone has no such commit. */
  resolve: (commit: string) => string | undefined;
  /** Whether `ancestor` is `commit` or comes before it. Each is a SHA, a tag or `MAIN`. */
  isAncestor: (ancestor: string, commit: string) => boolean;
  tags: () => readonly string[];
  /** The commits after `from`, up to and with `to`, that change RIVI_BOT_PATHS, newest first. */
  commits: (from: string, to: string) => readonly Commit[];
  /** The latest check runs that CI_CHECK's app reported on the commit, one per job. */
  ciChecks: (sha: string) => Promise<readonly CheckRun[]>;
  waitingDraft: () => Promise<Draft | undefined>;
}

export interface ReleasePlan {
  tag: string;
  sha: string;
  /** The tag of the release before this one. */
  last: string;
  commits: readonly Commit[];
  bump: Bump;
  requested: Requested;
  notes: string;
  warnings: string[];
  /** CI_CHECK's run that passed on the commit. */
  ci: string;
}

const isRequested = (value: string | undefined): value is Requested =>
  value === "auto" ||
  value === "major" ||
  value === "minor" ||
  value === "patch";

const FETCH = "Fetch main and its tags first: git fetch origin main --tags";

/** What the workflow's run asks for. */
export interface ReleaseInput {
  /** auto, major, minor or patch. */
  bump: string | undefined;
  /** A commit SHA, or empty for the head of main. */
  commit: string | undefined;
  /** The ref the workflow runs from, unset outside GitHub Actions. */
  ref: string | undefined;
}

/** The part the run asks to raise and the commit it names, once both are checked. */
const checkInput = ({ bump, commit, ref }: ReleaseInput) => {
  if (!isRequested(bump)) {
    throw new Error(
      `BUMP is ${bump || "unset"}: set it to auto, major, minor or patch.`
    );
  }

  // A run from another branch would run that branch's copy of the script.
  if (ref && ref !== "refs/heads/main") {
    throw new Error(`Run the workflow from main, not ${ref}.`);
  }

  const name = commit?.trim() || MAIN;

  if (name !== MAIN && !/^[\da-f]{7,40}$/iu.test(name)) {
    throw new Error(`COMMIT is not a commit SHA: ${name}`);
  }

  return { requested: bump, commit: name };
};

/**
 * The URL of CI_CHECK's run on the commit, once it has passed. CI reports it only after its other
 * jobs finish, so a commit with their checks and not this one is still running.
 */
const checkCi = (checks: readonly CheckRun[], sha: string): string => {
  const verify = checks.find(({ name }) => name === CI_CHECK.name);

  if (!verify) {
    const [running] = checks;

    throw new Error(
      running
        ? `CI is still running on ${sha}, and ${CI_CHECK.name} has not reported yet: ${running.url}. Run this again once it passes.`
        : `CI has not run on ${sha}: it has no ${CI_CHECK.name} check.`
    );
  }

  if (verify.status !== "completed") {
    throw new Error(
      `CI is still running on ${sha}: ${verify.url}. Run this again once ${CI_CHECK.name} passes.`
    );
  }

  if (verify.conclusion !== "success") {
    throw new Error(
      `${CI_CHECK.name} ended as ${verify.conclusion} on ${sha}: ${verify.url}. Re-run CI, and run this again once it passes.`
    );
  }

  return verify.url;
};

/**
 * The release to draft, or an error that says why there is none. The clone is checked before
 * GitHub is asked: the run's inputs, then the commit (on main, after the last release, changing
 * rivi-bot), then CI on the commit, then a draft that waits. A tag is never moved, so each check
 * stops the run rather than warn, except a bump lower than the commit titles call for, which a
 * maintainer may mean.
 */
export const planRelease = async (
  input: ReleaseInput,
  source: ReleaseSource
): Promise<ReleasePlan> => {
  const { requested, commit } = checkInput(input);
  const sha = source.resolve(commit);

  if (!sha) {
    throw new Error(`${commit} is not a commit in this clone. ${FETCH}`);
  }

  if (!source.isAncestor(sha, MAIN)) {
    throw new Error(`${sha} is not on main.`);
  }

  const last = latestTag(source.tags());
  const lastVersion = last && parseTag(last);

  if (!last || !lastVersion) {
    throw new Error(`There is no rivi-bot-v* tag to follow. ${FETCH}`);
  }

  if (!source.isAncestor(last, sha)) {
    throw new Error(
      `${sha} comes before ${last}, or beside it: a release follows the last one.`
    );
  }

  const commits = source.commits(last, sha);

  if (commits.length === 0) {
    throw new Error(
      `Nothing in ${RIVI_BOT_PATHS.join(" or ")} changed between ${last} and ${sha}.`
    );
  }

  const fromTitles = bumpForAll(commits);
  const bump = requested === "auto" ? fromTitles : requested;
  const tag = tagFor(nextVersion(lastVersion, bump));

  const warnings = isHigher(fromTitles, bump)
    ? [
        `The commit titles call for a ${fromTitles} release, and the run asked for ${bump}. Check that no change needs a caller to act.`,
      ]
    : [];

  const ci = checkCi(await source.ciChecks(sha), sha);
  const draft = await source.waitingDraft();

  if (draft) {
    throw new Error(
      `${draft.tag} waits as a draft: ${draft.url}. Publish or delete it, then run this again.`
    );
  }

  return {
    tag,
    sha,
    last,
    commits,
    bump,
    requested,
    notes: releaseNotes({ tag, sha, commits }),
    warnings,
    ci,
  };
};
