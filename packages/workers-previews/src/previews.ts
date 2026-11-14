import { CloudflareApiError } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import type { CloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";

import {
  activeBuilds,
  blocksBranch,
  deletePreview,
  listPreviews,
  workerTag,
} from "./cloudflare.js";
import type { BuildInfo } from "./cloudflare.js";
import { previewName } from "./name.js";
import { planSweep } from "./sweep.js";
import type { RepositoryState, SweepEntry, SweepTarget } from "./sweep.js";

/** The Worker whose Previews these functions work on, and the clients they call Cloudflare with. */
export interface PreviewsTarget {
  /** A client for the account; its token needs Workers Scripts Edit. */
  api: CloudflareApi;
  worker: string;
  /**
   * The client for the Workers Builds API, which takes only a user-scoped token with Workers
   * Builds Configuration Read; default `api`. `false` deletes without checking for running builds.
   */
  builds?: CloudflareApi | false;
  /** The branch production deploys from. Default `main`. */
  productionBranch?: string;
  /** Where progress goes, a line at a time. */
  log?: (line: string) => void;
}

/** A Preview with its owner, the sweep's verdict and its latest deployment. */
export type PreviewEntry = SweepEntry & { deployedOn: string | null };

/** Each client's Worker tags, looked up once: a tag never changes. */
const tags = new WeakMap<CloudflareApi, Map<string, Promise<string>>>();

const cachedTag = (api: CloudflareApi, worker: string) => {
  let known = tags.get(api);

  if (!known) {
    tags.set(api, (known = new Map()));
  }

  let tag = known.get(worker);

  if (!tag) {
    tag = workerTag(api, worker);
    known.set(worker, tag);
    tag.catch(() => known.delete(worker));
  }

  return tag;
};

/** The Worker's Workers Builds that have not finished, of every branch. */
const readActiveBuilds = async (
  target: PreviewsTarget,
  builds: CloudflareApi
) => {
  const tag = await cachedTag(target.api, target.worker);

  try {
    return await activeBuilds(builds, tag);
  } catch (error) {
    if (
      !(error instanceof CloudflareApiError) ||
      ![400, 401, 403].includes(error.status)
    ) {
      throw error;
    }

    throw new Error(
      `Cloudflare refused to list the Workers Builds of ${target.worker} (HTTP ${error.status}). The Builds API takes only a user-scoped token with Workers Builds Configuration Read: set CLOUDFLARE_BUILDS_API_TOKEN to one, or skip the check for a Worker that Workers Builds does not build.`,
      { cause: error }
    );
  }
};

/** Throws while a Workers Build of `branch` (of any branch, when left out) has not finished. */
type BuildCheck = (branch?: string) => Promise<void>;

/** How long the sweep checks its targets against one read of the Worker's builds. */
const SWEEP_BUILDS_MAX_AGE_MS = 30_000;

/**
 * A build check that reads the Worker's builds again only once its last read is `maxAge`
 * milliseconds old, timed from when that read started; with the default 0, every check reads them.
 * Calls must not overlap.
 */
const buildCheck = (target: PreviewsTarget, maxAge = 0): BuildCheck => {
  const builds = target.builds ?? target.api;
  let last: { startedAt: number; active: BuildInfo[] } | undefined;

  return async (branch) => {
    if (builds === false) {
      return;
    }

    const now = Date.now();

    if (last === undefined || now - last.startedAt >= maxAge) {
      last = {
        startedAt: now,
        active: await readActiveBuilds(target, builds),
      };
    }

    const blocking = last.active.find((build) => blocksBranch(build, branch));

    if (blocking) {
      throw new Error(
        `A Workers Build ${branch === undefined ? "of the Worker" : `of ${branch}`} is ${blocking.status} (${blocking.build_uuid}): wait for it to finish, then delete again`
      );
    }
  };
};

const deleteNames = async (target: PreviewsTarget, names: string[]) => {
  const deleted: string[] = [];

  for (const name of new Set(names)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the Previews of one branch go one at a time, so the log names them in order
    const gone = await deletePreview(target.api, target.worker, name);

    if (gone) {
      deleted.push(name);
      target.log?.(`Deleted Preview ${name}`);
    }
  }

  return deleted;
};

const deleteBranch = async (
  target: PreviewsTarget,
  check: BuildCheck,
  branch: string,
  keep: Set<string>
) => {
  const name = previewName(branch, {
    productionBranch: target.productionBranch,
  });

  await check(branch);

  return deleteNames(
    target,
    [name, branch].filter((preview) => !keep.has(preview))
  );
};

const deleteName = async (
  target: PreviewsTarget,
  check: BuildCheck,
  name: string,
  builds: "all" | "none"
) => {
  if (builds === "all") {
    await check();
  }

  return deleteNames(target, [name]);
};

/** The Previews one target of the sweep clears. */
const deleteTarget = (
  target: PreviewsTarget,
  check: BuildCheck,
  sweep: SweepTarget,
  keep: Set<string>
) =>
  "branch" in sweep && sweep.branch !== undefined
    ? deleteBranch(target, check, sweep.branch, keep)
    : deleteName(target, check, sweep.name, sweep.builds);

const inventory = async (
  target: PreviewsTarget & {
    repository: () => Promise<RepositoryState>;
    keep?: readonly string[];
  }
) => {
  // The Previews first, then the repository, never both at once. A Preview is deployed after its
  // branch is pushed or its pull request opened, so the branch or pull request of each listed
  // Preview existed before the repository read starts, and is in it unless it is really gone. In
  // parallel, a Preview deployed while the repository is read can miss its branch, and the sweep
  // deletes it.
  const previews = await listPreviews(target.api, target.worker);
  const repository = await target.repository();

  const deployed = new Map(
    previews.map((preview) => [preview.name, preview.deployed_on])
  );

  const plan = planSweep(
    previews.map((preview) => preview.name),
    repository,
    { productionBranch: target.productionBranch, keep: target.keep }
  );

  return {
    entries: plan.entries.map((entry) => ({
      ...entry,
      deployedOn: deployed.get(entry.name) ?? null,
    })),
    targets: plan.targets,
  };
};

/** How the sweep names a target: its branch, or the Preview's name when the branch is unknown. */
export const targetLabel = (target: SweepTarget): string =>
  "branch" in target && target.branch !== undefined
    ? `branch ${target.branch}`
    : `Preview ${target.name}`;

/**
 * Deletes a branch's Previews: the one `previewName` names, and the one named after the raw branch,
 * which Cloudflare's Git integration and `wrangler preview` without `--name` create. Refuses,
 * before deleting either, while a Workers Build of the branch has not finished, since the build
 * would bring its Preview back or fail. Returns the names it deleted.
 */
export const deleteBranchPreviews = (
  target: PreviewsTarget,
  branch: string
): Promise<string[]> =>
  deleteBranch(target, buildCheck(target), branch, new Set());

/** The Worker's Previews, each with its owner, whether its branch is live, and the sweep's verdict. */
export const previewInventory = async (
  target: PreviewsTarget & {
    repository: () => Promise<RepositoryState>;
    keep?: readonly string[];
  }
): Promise<PreviewEntry[]> => {
  const found = await inventory(target);

  return found.entries;
};

/** What `sweepPreviews` found, and what it deleted. */
export interface SweepResult {
  /** Every Preview of the Worker, with its owner and the sweep's verdict. */
  entries: PreviewEntry[];
  /** The deletes that clear the stale Previews, each one tried once with `apply`. */
  targets: SweepTarget[];
  /** The Previews deleted; empty without `apply`. */
  deleted: string[];
  /** The targets whose delete failed, with why. */
  failed: { target: SweepTarget; error: string }[];
}

/**
 * Compares every Preview of the Worker with the repository's branches and pull requests, and with
 * `apply` deletes the stale ones (`planSweep`). Reads the Previews, then the repository, both before
 * it deletes anything, and throws when either may be incomplete. One target's failed delete, such as a branch whose build is
 * running, does not stop the rest: the result lists it under `failed`. Checks every target against
 * one read of the Worker's Workers Builds, and reads them again once that read is 30 seconds old.
 */
export const sweepPreviews = async (
  target: PreviewsTarget & {
    repository: () => Promise<RepositoryState>;
    keep?: readonly string[];
    apply?: boolean;
  }
): Promise<SweepResult> => {
  const { entries, targets } = await inventory(target);
  const result: SweepResult = { entries, targets, deleted: [], failed: [] };

  if (!target.apply) {
    return result;
  }

  const keep = new Set(target.keep);
  const check = buildCheck(target, SWEEP_BUILDS_MAX_AGE_MS);

  for (const sweep of targets) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one target at a time: a branch's build check must not race another's delete
      const deleted = await deleteTarget(target, check, sweep, keep);
      result.deleted.push(...deleted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      target.log?.(`Could not delete ${targetLabel(sweep)}: ${message}`);
      result.failed.push({ target: sweep, error: message });
    }
  }

  return result;
};
