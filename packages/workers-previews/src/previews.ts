import { CloudflareApiError } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import type { CloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";

import {
  activeBuilds,
  deletePreview,
  listPreviews,
  workerTag,
} from "./cloudflare.js";
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

/** Throws while a Workers Build of `branch` (of any branch, when left out) has not finished. */
const assertBuildsIdle = async (target: PreviewsTarget, branch?: string) => {
  if (target.builds === false) {
    return;
  }

  const tag = await cachedTag(target.api, target.worker);
  let active;

  try {
    active = await activeBuilds(target.builds ?? target.api, tag, branch);
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

  if (active.length) {
    throw new Error(
      `A Workers Build ${branch === undefined ? "of the Worker" : `of ${branch}`} is ${active[0].status} (${active[0].build_uuid}): wait for it to finish, then delete again`
    );
  }
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
  branch: string,
  keep: Set<string>
) => {
  const name = previewName(branch, {
    productionBranch: target.productionBranch,
  });

  await assertBuildsIdle(target, branch);

  return deleteNames(
    target,
    [name, branch].filter((preview) => !keep.has(preview))
  );
};

const deleteName = async (
  target: PreviewsTarget,
  name: string,
  builds: "all" | "none"
) => {
  if (builds === "all") {
    await assertBuildsIdle(target);
  }

  return deleteNames(target, [name]);
};

/** The Previews one target of the sweep clears. */
const deleteTarget = (
  target: PreviewsTarget,
  sweep: SweepTarget,
  keep: Set<string>
) =>
  "branch" in sweep && sweep.branch !== undefined
    ? deleteBranch(target, sweep.branch, keep)
    : deleteName(target, sweep.name, sweep.builds);

const inventory = async (
  target: PreviewsTarget & {
    repository: () => Promise<RepositoryState>;
    keep?: readonly string[];
  }
) => {
  const [previews, repository] = await Promise.all([
    listPreviews(target.api, target.worker),
    target.repository(),
  ]);

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
): Promise<string[]> => deleteBranch(target, branch, new Set());

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
 * `apply` deletes the stale ones (`planSweep`). Reads both lists before it deletes anything, and
 * throws when either may be incomplete. One target's failed delete, such as a branch whose build is
 * running, does not stop the rest: the result lists it under `failed`.
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

  for (const sweep of targets) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one target at a time: a branch's build check must not race another's delete
      const deleted = await deleteTarget(target, sweep, keep);
      result.deleted.push(...deleted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      target.log?.(`Could not delete ${targetLabel(sweep)}: ${message}`);
      result.failed.push({ target: sweep, error: message });
    }
  }

  return result;
};
