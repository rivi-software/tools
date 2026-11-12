/**
 * Whether a pull request comes with the changesets that CONTRIBUTING.md ("Making the change") asks
 * for: a change to what a package publishes needs a changeset that names the package, or the
 * change is never released. scripts/check-changeset.ts reads the pull request from git and runs
 * the check (.github/workflows/changeset.yml).
 */

/** The label a maintainer adds to a pull request that changes a package but releases nothing. */
export const WAIVER_LABEL = "no-changeset";

/**
 * The fields of a package's package.json that change what its users install. Each is compared as
 * written, key order included: the order of an export's conditions decides which one resolves.
 */
export const RELEASED_FIELDS = [
  "dependencies",
  "peerDependencies",
  "exports",
] as const;

export type ReleasedField = (typeof RELEASED_FIELDS)[number];

export type FileStatus = "added" | "modified" | "deleted";

/** A file the pull request changes, by its path from the root of the repository. */
export interface ChangedFile {
  path: string;
  status: FileStatus;
}

/** A value as JSON.parse returns it. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** The parts of a package's package.json that the check reads. */
export interface Manifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Json;
}

/** A package's package.json where the pull request starts and at its head, where there is one. */
export interface ManifestPair {
  base?: Manifest;
  head?: Manifest;
}

/** A package the pull request releases a change to, and the changes that release. */
export interface Release {
  name: string;
  /** The files the pull request changes in the package's `src/`. */
  sources: string[];
  /** The fields of the package's package.json that the pull request changes. */
  fields: ReleasedField[];
}

export interface PullRequest {
  files: readonly ChangedFile[];
  /** Each directory of packages/ that the pull request changes a file in, with its package.json. */
  manifests: Readonly<Record<string, ManifestPair>>;
  /** The changesets the pull request adds or changes, by path, as they read at its head. */
  changesets: Readonly<Record<string, string>>;
  labels: readonly string[];
}

export interface Verdict {
  releases: Release[];
  /** The releases that no changeset of the pull request names. */
  missing: Release[];
  /** Whether the pull request has the WAIVER_LABEL. */
  waived: boolean;
}

const STATUSES = new Map<string, FileStatus>([
  ["A", "added"],
  ["D", "deleted"],
]);

/**
 * The files `git diff --name-status --no-renames -z` lists: each as its status letter, then its
 * path, each ended by a NUL. Without renames, git reports a moved file as deleted and added.
 */
export const parseNameStatus = (output: string): ChangedFile[] => {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];

  for (let i = 0; i + 1 < fields.length; i += 2) {
    files.push({
      path: fields[i + 1],
      status: STATUSES.get(fields[i]) ?? "modified",
    });
  }

  return files;
};

const PACKAGE_PATH = /^packages\/(?<directory>[^/]+)\//u;

/** The directories of packages/ that the files are in, such as `workers-mail`. */
export const packageDirectories = (files: readonly ChangedFile[]): string[] => [
  ...new Set(
    files.flatMap(
      ({ path }) => PACKAGE_PATH.exec(path)?.groups?.directory ?? []
    )
  ),
];

/**
 * The packages that the pull request releases a change to: those whose `src/` it changes, or one
 * of the RELEASED_FIELDS of whose package.json. A package that the pull request adds needs no
 * changeset, because its first release is the version in its package.json. Neither does one it
 * removes, or a private one, which is never published.
 */
export const releasesOf = (
  files: readonly ChangedFile[],
  manifests: PullRequest["manifests"]
): Release[] =>
  Object.entries(manifests).flatMap(([directory, { base, head }]) => {
    if (!(base && head?.name) || head.private) {
      return [];
    }

    const sources = files.flatMap(({ path }) =>
      path.startsWith(`packages/${directory}/src/`) ? [path] : []
    );

    const fields = RELEASED_FIELDS.filter(
      (field) => JSON.stringify(base[field]) !== JSON.stringify(head[field])
    );

    return sources.length > 0 || fields.length > 0
      ? [{ name: head.name, sources, fields }]
      : [];
  });

/** Whether a path is a changeset: a Markdown file in `.changeset/` other than its README. */
export const isChangeset = (path: string): boolean =>
  /^\.changeset\/[^/]+\.md$/u.test(path) && path !== ".changeset/README.md";

const RELEASE_LINE =
  /^(?<quote>["']?)(?<name>[^"'\s:]+)\k<quote>\s*:\s*(?<bump>major|minor|patch)\s*$/u;

/**
 * The packages a changeset releases. Its front matter, between two `---` lines, names each package
 * with its bump, such as `"@rivi-software/workers-mail": patch`. A package with the bump `none`,
 * or a changeset without front matter, releases nothing.
 */
export const changesetReleases = (text: string): string[] => {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());

  const end = lines.indexOf("---", 1);

  if (lines[0] !== "---" || end === -1) {
    return [];
  }

  return lines
    .slice(1, end)
    .flatMap((line) => RELEASE_LINE.exec(line)?.groups?.name ?? []);
};

export const checkChangesets = ({
  files,
  manifests,
  changesets,
  labels,
}: PullRequest): Verdict => {
  const named = new Set(Object.values(changesets).flatMap(changesetReleases));
  const releases = releasesOf(files, manifests);

  return {
    releases,
    missing: releases.filter(({ name }) => !named.has(name)),
    waived: labels.includes(WAIVER_LABEL),
  };
};

/** Whether the check passes: every release has a changeset, or a maintainer waived them. */
export const passes = ({ missing, waived }: Verdict): boolean =>
  missing.length === 0 || waived;

const code = (text: string) => `\`${text}\``;

/** What a release changes, such as "`dependencies` in its package.json". */
export const describeRelease = ({ sources, fields }: Release): string => {
  const changes: string[] = [];

  if (sources.length === 1) {
    changes.push(code(sources[0]));
  } else if (sources.length > 1) {
    changes.push(`${sources.length} files in its ${code("src/")}`);
  }

  if (fields.length > 0) {
    changes.push(`${fields.map(code).join(", ")} in its package.json`);
  }

  return changes.join(" and ");
};

/** What the check found, as Markdown for the job summary and the log. */
export const report = (verdict: Verdict): string => {
  const { releases, missing, waived } = verdict;

  if (releases.length === 0) {
    return "The pull request changes no package's `src/`, and none of the `dependencies`, `peerDependencies` or `exports` in a package.json, so it needs no changeset.";
  }

  if (missing.length === 0) {
    return `A changeset names each package the pull request releases a change to: ${releases.map(({ name }) => code(name)).join(", ")}.`;
  }

  const list = missing.map(
    (release) => `- ${code(release.name)}: ${describeRelease(release)}.`
  );

  if (waived) {
    return [
      `The ${code(WAIVER_LABEL)} label says the pull request releases nothing, so these packages need no changeset:`,
      "",
      ...list,
    ].join("\n");
  }

  return [
    "These packages need a changeset, or their change is never released:",
    "",
    ...list,
    "",
    `Run ${code("pnpm changeset")}, pick each package and its bump, and commit the file it writes to ${code(".changeset/")}. When the change releases nothing, a maintainer adds the ${code(WAIVER_LABEL)} label instead (CONTRIBUTING.md, "Making the change").`,
  ].join("\n");
};
