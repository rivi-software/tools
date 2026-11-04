import {
  type CloudflareApi,
  CloudflareApiError,
} from "@rivi-software/cloudflare-deploy/cloudflare-api";
import { activeBuilds, deletePreview, listPreviews, workerTag } from "./cloudflare.js";
import { previewName } from "./name.js";
import { planSweep, type RepositoryState, type SweepEntry, type SweepTarget } from "./sweep.js";

/** The Worker whose Previews these functions work on, and the clients they call Cloudflare with. */
export type PreviewsTarget = {
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
};

/** A Preview with its owner, the sweep's verdict and its latest deployment. */
export type PreviewEntry = SweepEntry & { deployedOn: string | null };

/**
 * Deletes a branch's Previews: the one `previewName` names, and the one named after the raw branch,
 * which Cloudflare's Git integration and `wrangler preview` without `--name` create. Refuses,
 * before deleting either, while a Workers Build of the branch has not finished, since the build
 * would bring its Preview back or fail. Returns the names it deleted.
 */
export async function deleteBranchPreviews(
  target: PreviewsTarget,
  branch: string,
): Promise<string[]> {
  return deleteBranch(target, branch, new Set());
}

/** The Worker's Previews, each with its owner, whether its branch is live, and the sweep's verdict. */
export async function previewInventory(
  target: PreviewsTarget & { repository: () => Promise<RepositoryState>; keep?: readonly string[] },
): Promise<PreviewEntry[]> {
  return (await inventory(target)).entries;
}

export type SweepResult = {
  entries: PreviewEntry[];
  targets: SweepTarget[];
  /** The Previews deleted; empty without `apply`. */
  deleted: string[];
  /** The targets whose delete failed, with why. */
  failed: { target: SweepTarget; error: string }[];
};

/**
 * Compares every Preview of the Worker with the repository's branches and pull requests, and with
 * `apply` deletes the stale ones (`planSweep`). Reads both lists before it deletes anything, and
 * throws when either may be incomplete. One target's failed delete, such as a branch whose build is
 * running, does not stop the rest: the result lists it under `failed`.
 */
export async function sweepPreviews(
  target: PreviewsTarget & {
    repository: () => Promise<RepositoryState>;
    keep?: readonly string[];
    apply?: boolean;
  },
): Promise<SweepResult> {
  const { entries, targets } = await inventory(target);
  const result: SweepResult = { entries, targets, deleted: [], failed: [] };
  if (!target.apply) return result;
  const keep = new Set(target.keep);
  for (const sweep of targets) {
    try {
      result.deleted.push(
        ...("branch" in sweep && sweep.branch !== undefined
          ? await deleteBranch(target, sweep.branch, keep)
          : await deleteName(target, sweep.name, sweep.builds)),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      target.log?.(`Could not delete ${targetLabel(sweep)}: ${message}`);
      result.failed.push({ target: sweep, error: message });
    }
  }
  return result;
}

/** How the sweep names a target: its branch, or the Preview's name when the branch is unknown. */
export function targetLabel(target: SweepTarget): string {
  return "branch" in target && target.branch !== undefined
    ? `branch ${target.branch}`
    : `Preview ${target.name}`;
}

async function inventory(
  target: PreviewsTarget & { repository: () => Promise<RepositoryState>; keep?: readonly string[] },
) {
  const [previews, repository] = await Promise.all([
    listPreviews(target.api, target.worker),
    target.repository(),
  ]);
  const deployed = new Map(previews.map((preview) => [preview.name, preview.deployed_on]));
  const plan = planSweep(
    previews.map((preview) => preview.name),
    repository,
    { productionBranch: target.productionBranch, keep: target.keep },
  );
  return {
    entries: plan.entries.map((entry) => ({
      ...entry,
      deployedOn: deployed.get(entry.name) ?? null,
    })),
    targets: plan.targets,
  };
}

async function deleteBranch(target: PreviewsTarget, branch: string, keep: Set<string>) {
  const name = previewName(branch, { productionBranch: target.productionBranch });
  await assertBuildsIdle(target, branch);
  return deleteNames(
    target,
    [name, branch].filter((preview) => !keep.has(preview)),
  );
}

async function deleteName(target: PreviewsTarget, name: string, builds: "all" | "none") {
  if (builds === "all") await assertBuildsIdle(target);
  return deleteNames(target, [name]);
}

async function deleteNames(target: PreviewsTarget, names: string[]) {
  const deleted: string[] = [];
  for (const name of new Set(names))
    if (await deletePreview(target.api, target.worker, name)) {
      deleted.push(name);
      target.log?.(`Deleted Preview ${name}`);
    }
  return deleted;
}

/** Each client's Worker tags, looked up once: a tag never changes. */
const tags = new WeakMap<CloudflareApi, Map<string, Promise<string>>>();

function cachedTag(api: CloudflareApi, worker: string) {
  let known = tags.get(api);
  if (!known) tags.set(api, (known = new Map()));
  let tag = known.get(worker);
  if (!tag) {
    tag = workerTag(api, worker);
    known.set(worker, tag);
    tag.catch(() => known.delete(worker));
  }
  return tag;
}

/** Throws while a Workers Build of `branch` (of any branch, when left out) has not finished. */
async function assertBuildsIdle(target: PreviewsTarget, branch?: string) {
  if (target.builds === false) return;
  const tag = await cachedTag(target.api, target.worker);
  let active;
  try {
    active = await activeBuilds(target.builds ?? target.api, tag, branch);
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || ![400, 401, 403].includes(error.status))
      throw error;
    throw new Error(
      `Cloudflare refused to list the Workers Builds of ${target.worker} (HTTP ${error.status}). The Builds API takes only a user-scoped token with Workers Builds Configuration Read: set CLOUDFLARE_BUILDS_API_TOKEN to one, or skip the check for a Worker that Workers Builds does not build.`,
      { cause: error },
    );
  }
  if (active.length)
    throw new Error(
      `A Workers Build ${branch === undefined ? "of the Worker" : `of ${branch}`} is ${active[0].status} (${active[0].build_uuid}): wait for it to finish, then delete again`,
    );
}
