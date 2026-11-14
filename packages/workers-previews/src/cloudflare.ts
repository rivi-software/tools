import { CloudflareApiError } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import type { CloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";

/** A Preview as the Workers API lists it (the fields this package reads). */
export interface PreviewInfo {
  id: string;
  name: string;
  slug: string;
  urls: string[];
  created_on: string;
  /** When its latest deployment was made; `null` for a Preview never deployed to. */
  deployed_on: string | null;
}

/** A Workers Build as the Builds API lists it (the fields this package reads). */
export interface BuildInfo {
  build_uuid: string;
  status: "queued" | "initializing" | "running" | "stopped";
  build_trigger_metadata?: { branch?: string };
}

/** Cloudflare's codes for a Worker that does not exist (wrangler's `isWorkerNotFoundError`). */
const WORKER_NOT_FOUND = [10_007, 10_090];

/** The most pages a listing reads before it gives up rather than act on part of the list. */
const MAX_PAGES = 100;

const previewsPath = (worker: string) =>
  `/workers/workers/${encodeURIComponent(worker)}/previews`;

/** A 404 that names a missing Worker becomes an error that says so; any other error stays. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- what a rejected API call throws is unknown until this reads it
const workerMissing = (error: unknown, worker: string) =>
  error instanceof CloudflareApiError &&
  WORKER_NOT_FOUND.some((code) => error.has(code))
    ? new Error(`The Worker ${worker} does not exist in this account`, {
        cause: error,
      })
    : error;

/**
 * Every Preview of the Worker, oldest first, 100 a page. Throws when the Worker does not exist,
 * and when the list runs past 100 pages (Cloudflare keeps at most 500 Previews a Worker).
 */
export const listPreviews = async (
  api: CloudflareApi,
  worker: string
): Promise<PreviewInfo[]> => {
  const previews: PreviewInfo[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let batch: PreviewInfo[] | null;

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each page needs the count of the page before to know whether another follows
      batch = await api.call<PreviewInfo[] | null>(
        "GET",
        previewsPath(worker),
        {
          query: { page, per_page: 100, order_by: "created_on", order: "asc" },
        }
      );
    } catch (error) {
      throw workerMissing(error, worker);
    }

    previews.push(...(batch ?? []));

    if ((batch ?? []).length < 100) {
      return previews;
    }
  }

  throw new Error(
    `The Previews of ${worker} run past ${MAX_PAGES} pages; the list may be incomplete`
  );
};

/**
 * Deletes the Preview with this name, and every deployment of it. `false` when the Worker has no
 * Preview by that name; throws when the Worker itself does not exist.
 */
export const deletePreview = async (
  api: CloudflareApi,
  worker: string,
  name: string
): Promise<boolean> => {
  try {
    await api.call<unknown>(
      "DELETE",
      `${previewsPath(worker)}/${encodeURIComponent(name)}`
    );

    return true;
  } catch (error) {
    const missing = workerMissing(error, worker);

    if (
      missing === error &&
      error instanceof CloudflareApiError &&
      error.status === 404
    ) {
      return false;
    }

    throw missing;
  }
};

/**
 * The Worker's tag, the immutable ID the Builds API knows it by, from the account's list of Worker
 * scripts. Throws when the account has no Worker by that name.
 */
export const workerTag = async (
  api: CloudflareApi,
  worker: string
): Promise<string> => {
  const scripts = await api.call<{ id: string; tag?: string }[]>(
    "GET",
    "/workers/scripts"
  );

  const tag = scripts.find((script) => script.id === worker)?.tag;

  if (!tag) {
    throw new Error(`The Worker ${worker} does not exist in this account`);
  }

  return tag;
};

/**
 * Whether a build has not finished and holds up `branch` (any branch, when left out). A build
 * without branch metadata holds up every branch.
 */
export const blocksBranch = (build: BuildInfo, branch?: string): boolean =>
  build.status !== "stopped" &&
  (branch === undefined ||
    build.build_trigger_metadata?.branch === undefined ||
    build.build_trigger_metadata.branch === branch);

/**
 * The Worker's Workers Builds that have not finished: of `branch`, or of any branch when it is
 * left out. A build without branch metadata counts for every branch. A Worker that Workers Builds
 * has never built has none. Pages through the builds Cloudflare keeps (90 days), 200 at a time,
 * and throws past 100 pages rather than miss a running one.
 */
export const activeBuilds = async (
  api: CloudflareApi,
  tag: string,
  branch?: string
): Promise<BuildInfo[]> => {
  const active: BuildInfo[] = [];
  const path = `/builds/workers/${encodeURIComponent(tag)}/builds`;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page needs the count of the page before to know whether another follows
    const found = await api.maybe<BuildInfo[] | null>("GET", path, {
      query: { page, per_page: 200 },
    });

    const batch = found ?? [];

    active.push(...batch.filter((build) => blocksBranch(build, branch)));

    if (batch.length < 200) {
      return active;
    }
  }

  throw new Error(
    `The Workers Builds of ${tag} run past ${MAX_PAGES} pages; refusing to delete`
  );
};
