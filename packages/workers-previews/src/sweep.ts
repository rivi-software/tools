import { isPreviewName, previewName } from "./name.js";

/**
 * A pull request. `fork` marks one whose branch is in another repository: it counts only for its
 * `pr-<number>` Preview, since its branch is not one of the repository's.
 */
export type PullRequest = { number: number; branch: string; open: boolean; fork?: boolean };

/**
 * What the sweep compares the Previews with: every live branch, and the pull requests. Every open
 * pull request must be there; closed ones may be only the recent ones, since a missing one only
 * keeps a Preview longer.
 */
export type RepositoryState = { branches: string[]; pullRequests: PullRequest[] };

/** Where a Preview's name comes from. */
export type PreviewOwner =
  /** Named after the production branch, which the sweep never deletes. */
  | { kind: "production"; branch: string }
  /** A name `previewName` made; `branch` when a known branch or pull request hashes to it. */
  | { kind: "hashed"; branch?: string }
  /** `pr-<number>`, the name Cloudflare's GitHub Actions example gives; `branch` unless it is a fork's. */
  | { kind: "pull-request"; number: number; branch?: string }
  /** Any other name, taken as a branch name: `wrangler preview`'s default, and the Git integration's. */
  | { kind: "raw"; branch: string };

/** The options of `planSweep`. */
export type SweepOptions = {
  /** The branch production deploys from. Default `main`. */
  productionBranch?: string;
  /** Previews the sweep never deletes, by name. */
  keep?: readonly string[];
};

/** A Preview with its owner and the sweep's verdict. */
export type SweepEntry = { name: string } & PreviewOwner & {
    /** Whether the owning branch is live; `undefined` when the branch is unknown. */
    branchExists?: boolean;
    action: "delete" | "keep";
    reason: string;
  };

/**
 * One delete of the sweep. A branch target removes both of the branch's Previews (its hashed name
 * and its raw name) once the branch's Workers Builds are idle; a name target removes one Preview,
 * after every build of the Worker is idle when its branch is unknown (`builds: "all"`).
 */
export type SweepTarget =
  | { branch: string }
  | { name: string; builds: "all" | "none"; branch?: undefined };

/** The Previews' owners and verdicts, in name order, and the deletes that clear the stale ones. */
export type SweepPlan = { entries: SweepEntry[]; targets: SweepTarget[] };

/**
 * The owner of a Preview name. A hashed name is matched to the branch or pull request whose
 * `previewName` it is; one that no known branch hashes to, but that is itself a branch, is raw.
 */
export function previewOwner(
  name: string,
  repository: RepositoryState,
  options: Pick<SweepOptions, "productionBranch"> = {},
): PreviewOwner {
  const production = options.productionBranch ?? "main";
  return ownerOf(name, repository, production, branchIndex(repository, production));
}

/**
 * Sorts each Preview into stale and live. A Preview is stale when its branch is gone, or when the
 * branch is live but every pull request from it is closed. An open pull request keeps it, and so
 * does a live branch that never had one. Throws when the branches lack the production branch: the
 * list is then from the wrong repository, or the production branch is not `main`.
 */
export function planSweep(
  previews: readonly string[],
  repository: RepositoryState,
  options: SweepOptions = {},
): SweepPlan {
  const production = options.productionBranch ?? "main";
  const live = new Set(repository.branches);
  if (!live.has(production))
    throw new Error(
      `The repository's branches do not include the production branch ${production}: refusing to sweep against a list that may be wrong`,
    );
  const keep = new Set(options.keep ?? []);
  const branchVerdict = (branch: string): Pick<SweepEntry, "action" | "reason"> => {
    const own = repository.pullRequests.filter((pull) => !pull.fork && pull.branch === branch);
    if (own.some((pull) => pull.open)) return { action: "keep", reason: "open pull request" };
    if (!live.has(branch)) return { action: "delete", reason: "branch deleted" };
    if (own.length === 0) return { action: "keep", reason: "branch has no pull request" };
    return { action: "delete", reason: "every pull request from the branch is closed" };
  };
  const verdict = (name: string, owner: PreviewOwner): Pick<SweepEntry, "action" | "reason"> => {
    if (keep.has(name)) return { action: "keep", reason: "kept by name" };
    switch (owner.kind) {
      case "production":
        return { action: "keep", reason: "production branch" };
      case "pull-request":
        return repository.pullRequests.some((pull) => pull.number === owner.number && pull.open)
          ? { action: "keep", reason: "open pull request" }
          : { action: "delete", reason: "pull request closed" };
      case "hashed":
        return owner.branch === undefined
          ? { action: "delete", reason: "no live branch or pull request has this name" }
          : branchVerdict(owner.branch);
      case "raw":
        return branchVerdict(owner.branch);
    }
  };

  const index = branchIndex(repository, production);
  const entries = [...new Set(previews)].sort().map((name): SweepEntry => {
    const owner = ownerOf(name, repository, production, index);
    const branch = "branch" in owner ? owner.branch : undefined;
    return {
      name,
      ...owner,
      ...(branch === undefined ? {} : { branchExists: live.has(branch) }),
      ...verdict(name, owner),
    };
  });

  const targets = new Map<string, SweepTarget>();
  for (const entry of entries) {
    if (entry.action !== "delete" || entry.kind === "production") continue;
    if (entry.kind === "pull-request")
      // Workers Builds never makes a `pr-<n>` Preview, so no build of it can be running.
      targets.set(`name:${entry.name}`, { name: entry.name, builds: "none" });
    else if (entry.branch === undefined)
      targets.set(`name:${entry.name}`, { name: entry.name, builds: "all" });
    else targets.set(`branch:${entry.branch}`, { branch: entry.branch });
  }
  return { entries, targets: [...targets.values()] };
}

function ownerOf(
  name: string,
  repository: RepositoryState,
  production: string,
  index: BranchIndex,
): PreviewOwner {
  if (name === production) return { kind: "production", branch: production };
  const pr = /^pr-([1-9][0-9]*)$/.exec(name);
  if (pr) {
    const number = Number(pr[1]);
    const pull = repository.pullRequests.find((pull) => pull.number === number);
    const branch = pull?.fork ? undefined : pull?.branch;
    return branch === undefined
      ? { kind: "pull-request", number }
      : { kind: "pull-request", number, branch };
  }
  if (isPreviewName(name)) {
    const branch = index.hashed.get(name);
    if (branch !== undefined) return { kind: "hashed", branch };
    // A branch that happens to look like a hashed name, deployed under its own name.
    if (!index.known.has(name)) return { kind: "hashed" };
  }
  return { kind: "raw", branch: name };
}

type BranchIndex = { known: Set<string>; hashed: Map<string, string> };

/** Every branch the repository knows of (the live ones and its own pull requests' heads), and each one's `previewName`. */
function branchIndex(repository: RepositoryState, production: string): BranchIndex {
  const known = new Set([
    ...repository.branches,
    ...repository.pullRequests.filter((pull) => !pull.fork).map((pull) => pull.branch),
  ]);
  const hashed = new Map<string, string>();
  for (const branch of known)
    if (branch && branch !== production)
      hashed.set(previewName(branch, { productionBranch: production }), branch);
  return { known, hashed };
}
