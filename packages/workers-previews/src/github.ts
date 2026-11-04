import type { PullRequest, RepositoryState } from "./sweep.js";

export type GitHubRepositoryOptions = {
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
};

type Branch = { name: string };
type Pull = {
  number: number;
  state: string;
  head: { ref: string; repo: { full_name: string } | null };
};

/** The most pages of branches or open pull requests read before the list counts as incomplete. */
const MAX_PAGES = 100;

/**
 * Reads a GitHub repository's state for the sweep: every branch and every open pull request, and
 * the most recently updated closed ones. Throws, so the sweep deletes nothing, when GitHub fails
 * or the branches or open pull requests run past 100 pages. A missing closed pull request only
 * keeps a Preview, so those stop after `closedPages`. A pull request from a fork, or from a
 * deleted repository, comes with `fork: true`.
 */
export function githubRepository(options: GitHubRepositoryOptions): () => Promise<RepositoryState> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository))
    throw new Error(`Not a GitHub repository (owner/name): ${options.repository}`);
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const transport = options.fetch ?? ((input, init) => fetch(input, init));
  const own = options.repository.toLowerCase();

  /** Every item of a listing, page by page, up to `limit` pages; `complete` says whether it ended. */
  async function list<T>(path: string, limit: number) {
    const items: T[] = [];
    for (let page = 1; page <= limit; page++) {
      const url = `${apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
      const response = await transport(url, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `GitHub GET ${path} failed (HTTP ${response.status})${response.status === 404 ? `: check the repository's name, and that the token can read it` : ""}`,
        );
      }
      const batch = (await response.json()) as unknown;
      if (!Array.isArray(batch))
        throw new Error(`GitHub GET ${path} answered something other than a list`);
      items.push(...(batch as T[]));
      // A full page may have a next one even when the Link header is missing; an empty one ends it.
      const next = /<[^>]*>;\s*rel="next"/.test(response.headers.get("link") ?? "");
      if (!next && batch.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  }

  const pullRequest = (pull: Pull, open: boolean): PullRequest => ({
    number: pull.number,
    branch: pull.head.ref,
    open,
    ...(pull.head.repo?.full_name.toLowerCase() === own ? {} : { fork: true }),
  });

  return async () => {
    const repo = `/repos/${options.repository}`;
    const [branches, open, closed] = await Promise.all([
      list<Branch>(`${repo}/branches`, MAX_PAGES),
      list<Pull>(`${repo}/pulls?state=open`, MAX_PAGES),
      list<Pull>(
        `${repo}/pulls?state=closed&sort=updated&direction=desc`,
        options.closedPages ?? 10,
      ),
    ]);
    if (!branches.complete || !open.complete)
      throw new Error(
        `The ${branches.complete ? "open pull requests" : "branches"} of ${options.repository} run past ${MAX_PAGES} pages; the list may be incomplete`,
      );
    return {
      branches: branches.items.map((branch) => branch.name),
      pullRequests: [
        ...open.items.map((pull) => pullRequest(pull, true)),
        ...closed.items.map((pull) => pullRequest(pull, false)),
      ],
    };
  };
}
