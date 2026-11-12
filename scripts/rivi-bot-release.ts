/**
 * The next rivi-bot release that scripts/release-rivi-bot.ts drafts: its version and its notes. A
 * version is a `rivi-bot-v<major>.<minor>.<patch>` tag, and CONTRIBUTING.md ("A rivi-bot release")
 * says which part a change raises.
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
    `Pin an action to this tag, such as \`rivi-software/tools/rivi-bot@${tag}\` or \`rivi-software/tools/rivi-bot/triage@${tag}\`, or to its commit, \`${sha}\`.`,
  ];

  if (rest.length > 0) {
    sections.push(`### Changes\n\n${rest.map(bullet).join("\n")}`);
  }

  if (breaking.length > 0) {
    sections.push(`### Upgrading\n\n${breaking.map(bullet).join("\n")}`);
  }

  return `${sections.join("\n\n")}\n`;
};
