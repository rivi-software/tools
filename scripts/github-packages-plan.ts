/**
 * Which releases scripts/mirror-github-packages.ts copies from npm to GitHub Packages, and the
 * dist-tag it publishes each with.
 */

/** The parts of a package's packument, the registry's document for it, that the plan reads. */
export interface Packument {
  "dist-tags": Record<string, string>;
  versions: Record<string, { repository?: string | { url?: string } }>;
  time: Record<string, string>;
}

export interface Copy {
  version: string;
  tag: string;
}

/** The releases to copy, and those no dist-tag can carry. */
export interface CopyPlan {
  copies: Copy[];
  leftOut: string[];
}

const REPOSITORY = "https://github.com/rivi-software/tools";

/** Whether a manifest's `repository` is the short form, the URL on its own. */
const isRepositoryUrl = (
  repository: Packument["versions"][string]["repository"]
): repository is string => typeof repository === "string";

/**
 * Whether a version's manifest names this repository. Every release does (check:manifests
 * enforces it, and GitHub Packages links the package to the repository it names); the placeholder
 * npm publishes for staged publishing, `0.0.0-stage`, names none.
 */
export const fromThisRepository = (
  manifest: Packument["versions"][string]
): boolean => {
  const { repository } = manifest;
  const url = isRepositoryUrl(repository) ? repository : repository?.url;

  return url?.replace(/^git\+/u, "").replace(/\.git$/u, "") === REPOSITORY;
};

/**
 * The releases npm has and GitHub Packages lacks, oldest first, each with the dist-tag to publish
 * it with, and those it leaves out.
 *
 * GitHub Packages sets a dist-tag only as it publishes a version: it has no `npm dist-tag`, so a
 * tag cannot be put back afterwards. A copy therefore gets npm's own tag for that version
 * (`latest` when it has several), or else a tag that a later copy in the same run is published
 * with and so takes back: `latest` for a release, another tag for a prerelease, where there is a
 * choice. When the copies are done, each tag they set points where it points on npm. A version
 * with neither kind of tag is left out rather than move a tag back.
 */
export const planCopies = (
  npm: Packument,
  onGitHub: ReadonlySet<string>
): CopyPlan => {
  const missing = Object.keys(npm.versions)
    .filter(
      (version) =>
        !onGitHub.has(version) && fromThisRepository(npm.versions[version])
    )
    .toSorted((a, b) => Date.parse(npm.time[a]) - Date.parse(npm.time[b]));

  const ownTags = missing.map((version) => {
    const tags = Object.keys(npm["dist-tags"]).filter(
      (tag) => npm["dist-tags"][tag] === version
    );

    return tags.includes("latest") ? "latest" : tags[0];
  });

  const copies: Copy[] = [];
  const leftOut: string[] = [];

  for (const [i, version] of missing.entries()) {
    const later = ownTags.slice(i + 1).filter((tag) => tag !== undefined);

    const preferred = version.includes("-")
      ? later.find((tag) => tag !== "latest")
      : later.find((tag) => tag === "latest");

    const tag = ownTags[i] ?? preferred ?? later[0];

    if (tag) {
      copies.push({ version, tag });
    } else {
      leftOut.push(version);
    }
  }

  return { copies, leftOut };
};
