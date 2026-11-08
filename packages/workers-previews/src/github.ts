import type { PullRequest, RepositoryState } from "./sweep.js";

/** The repository `githubRepository` reads, and how it reaches GitHub. */
export interface GitHubRepositoryOptions {
  /** `owner/name`. */
  repository: string;
  /** A token that can read the repository; GitHub Actions' `GITHUB_TOKEN` can. Optional for a public repository. */
  token?: string;
  /** Default `https://api.github.com`; GitHub Enterprise Server's is `https://<host>/api/v3`. */
  apiUrl?: string;
  /** How many pages of 100 recently updated closed pull requests to read. Default 10. */
  closedPages?: number;
  /** The transport; tests pass a fake. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface Branch {
  name: string;
}

interface Pull {
  number: number;
  state: string;
  head: { ref: string; repo: { full_name: string } | null };
}

/** The most pages of branches or open pull requests read before the list counts as incomplete. */
const MAX_PAGES = 100;

/** `owner/name`, the only form the GitHub API takes. */
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

/** A trailing slash on the API URL, which would double up in a path. */
const TRAILING_SLASH = /\/$/u;

/** The Link header of a listing that has a page after this one. */
const NEXT_LINK = /<[^>]*>;\s*rel="next"/u;

/** One page of a listing: its items, and whether another page follows. */
const readPage = async (
  transport: typeof fetch,
  url: string,
  path: string,
  token: string | undefined
): Promise<{ items: unknown[]; next: boolean }> => {
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  });

  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const response = await transport(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `GitHub GET ${path} failed (HTTP ${response.status})${response.status === 404 ? `: check the repository's name, and that the token can read it` : ""}`
    );
  }

  const batch: unknown = await response.json();
  const isList = Array.isArray(batch);

  if (!isList) {
    throw new Error(`GitHub GET ${path} answered something other than a list`);
  }

  // A full page may have a next one even when the Link header is missing; an empty one ends it.
  const next =
    NEXT_LINK.test(response.headers.get("link") ?? "") || batch.length >= 100;

  return { items: batch, next };
};

/**
 * Reads a GitHub repository's state for the sweep: every branch and every open pull request, and
 * the most recently updated closed ones. Throws, so the sweep deletes nothing, when GitHub fails
 * or the branches or open pull requests run past 100 pages. A missing closed pull request only
 * keeps a Preview, so those stop after `closedPages`. A pull request from a fork, or from a
 * deleted repository, comes with `fork: true`.
 */
export const githubRepository = (
  options: GitHubRepositoryOptions
): (() => Promise<RepositoryState>) => {
  if (!REPOSITORY.test(options.repository)) {
    throw new Error(
      `Not a GitHub repository (owner/name): ${options.repository}`
    );
  }

  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(
    TRAILING_SLASH,
    ""
  );

  const transport = options.fetch ?? ((input, init) => fetch(input, init));
  const own = options.repository.toLowerCase();

  /** Every item of a listing, page by page, up to `limit` pages; `complete` says whether it ended. */
  const list = async <T>(path: string, limit: number) => {
    const items: T[] = [];

    for (let page = 1; page <= limit; page += 1) {
      const url = `${apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;

      // oxlint-disable-next-line eslint/no-await-in-loop -- a page can only be read once the one before says another follows
      const read = await readPage(transport, url, path, options.token);

      // SAFETY: the listing's path decides what the items are; the caller names that type as T.
      items.push(...(read.items as T[]));

      if (!read.next) {
        return { items, complete: true };
      }
    }

    return { items, complete: false };
  };

  const pullRequest = (pull: Pull, open: boolean): PullRequest => {
    const base = { number: pull.number, branch: pull.head.ref, open };

    return pull.head.repo?.full_name.toLowerCase() === own
      ? base
      : { ...base, fork: true };
  };

  return async () => {
    const repo = `/repos/${options.repository}`;

    const [branches, open, closed] = await Promise.all([
      list<Branch>(`${repo}/branches`, MAX_PAGES),
      list<Pull>(`${repo}/pulls?state=open`, MAX_PAGES),
      list<Pull>(
        `${repo}/pulls?state=closed&sort=updated&direction=desc`,
        options.closedPages ?? 10
      ),
    ]);

    if (!branches.complete || !open.complete) {
      throw new Error(
        `The ${branches.complete ? "open pull requests" : "branches"} of ${options.repository} run past ${MAX_PAGES} pages; the list may be incomplete`
      );
    }

    return {
      branches: branches.items.map((branch) => branch.name),
      pullRequests: [
        ...open.items.map((pull) => pullRequest(pull, true)),
        ...closed.items.map((pull) => pullRequest(pull, false)),
      ],
    };
  };
};
