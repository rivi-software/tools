/**
 * A fake of the Cloudflare and GitHub endpoints this package calls, behind one `fetch`: a Worker's
 * Previews, the account's Worker scripts with their tags, the Workers Builds of a tag, and a
 * repository's branches and pull requests, each paged as the real APIs page.
 */

export const ACCOUNT = "a".repeat(32);
export const TOKEN = "cloudflare-token";

export interface FakePreview {
  name: string;
  created_on: string;
  deployed_on: string | null;
}

export interface FakeBuild {
  build_uuid: string;
  status: "queued" | "initializing" | "running" | "stopped";
  build_trigger_metadata?: { branch?: string };
}

export interface FakePull {
  number: number;
  state: "open" | "closed";
  head: { ref: string; repo: { full_name: string } | null };
}

export interface FakeState {
  /** The account's Workers, by name: their tag and Previews. */
  workers: Record<string, { tag: string; previews: FakePreview[] }>;
  /** Workers Builds by Worker tag; a tag missing here answers 404, as for a Worker never built. */
  builds: Record<string, FakeBuild[]>;
  /** The only token the Builds API takes; any other answers 403. Default `TOKEN`. */
  buildsToken?: string;
  /** Repositories by `owner/name`. */
  repositories: Record<string, { branches: string[]; pulls: FakePull[] }>;
  /** Leaves GitHub's Link header out, as a proxy might. */
  dropLinks?: boolean;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the fake wraps whatever payload a route answers with, as Cloudflare's envelope does
const envelope = (result: unknown, status = 200) =>
  Response.json(
    { success: status < 400, errors: [], messages: [], result },
    { status }
  );

const failure = (status: number, code: number, message: string) =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status }
  );

/** A Preview as the fake stores it, from its name and the time it was made. */
export const preview = (
  name: string,
  deployedOn: string | null = "2026-11-01T00:00:00Z"
): FakePreview => ({
  name,
  created_on: "2026-10-01T00:00:00Z",
  deployed_on: deployedOn,
});

/** A pull request from a branch of `repository`, or of a fork when `fork` names it. */
export const pull = (
  number: number,
  ref: string,
  state: "open" | "closed",
  repository = "acme/app"
): FakePull => ({
  number,
  state,
  head: { ref, repo: { full_name: repository } },
});

/** One page of a listing, as the query asks for it. */
const page = <T>(items: T[], url: URL, maxPerPage: number) => {
  const perPage = Math.min(
    Number(url.searchParams.get("per_page") ?? 30),
    maxPerPage
  );

  const number = Number(url.searchParams.get("page") ?? 1);

  return {
    items: items.slice((number - 1) * perPage, number * perPage),
    number,
    perPage,
  };
};

const BUILDS_PATH = /^\/builds\/workers\/(?<tag>[^/]+)\/builds$/u;

const PREVIEWS_PATH =
  /^\/workers\/workers\/(?<worker>[^/]+)\/previews(?:\/(?<preview>[^/]+))?$/u;

const REPOSITORY_PATH =
  /^\/repos\/(?<repository>[^/]+\/[^/]+)\/(?<kind>branches|pulls)$/u;

export const fakeApis = (state: FakeState) => {
  const calls: string[] = [];

  /** The Previews of one Worker: the listing, and the delete of a single Preview. */
  const previewRoute = (
    method: string,
    url: URL,
    token: string | null,
    previews: RegExpExecArray
  ): Response => {
    if (token !== `Bearer ${TOKEN}`) {
      return failure(403, 10_000, "Authentication error");
    }

    const worker =
      state.workers[decodeURIComponent(previews.groups?.worker ?? "")];

    if (!worker) {
      return failure(
        404,
        10_007,
        "This Worker does not exist on your account."
      );
    }

    const wanted = previews.groups?.preview;
    const name = wanted === undefined ? undefined : decodeURIComponent(wanted);

    if (method === "GET" && name === undefined) {
      const sorted = worker.previews.toSorted((a, b) =>
        a.created_on.localeCompare(b.created_on)
      );

      return envelope(
        page(sorted, url, 100).items.map((item) => ({
          id: `id-${item.name}`,
          slug: item.name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-"),
          urls: [],
          ...item,
        }))
      );
    }

    if (method === "DELETE" && name !== undefined) {
      const index = worker.previews.findIndex((item) => item.name === name);

      if (index === -1) {
        return failure(404, 10_025, "Preview not found");
      }

      worker.previews.splice(index, 1);

      return envelope(null);
    }

    return failure(400, 7000, "No route for that URI");
  };

  const cloudflare = (method: string, url: URL, headers: Headers): Response => {
    const token = headers.get("authorization");
    const path = url.pathname.slice(`/client/v4/accounts/${ACCOUNT}`.length);

    if (!url.pathname.startsWith(`/client/v4/accounts/${ACCOUNT}/`)) {
      return failure(403, 9109, "Unauthorized to access requested resource");
    }

    if (method === "GET" && path === "/workers/scripts") {
      if (token !== `Bearer ${TOKEN}`) {
        return failure(403, 10_000, "Authentication error");
      }

      return envelope(
        Object.entries(state.workers).map(([id, worker]) => ({
          id,
          tag: worker.tag,
        }))
      );
    }

    const builds = BUILDS_PATH.exec(path);

    if (builds && method === "GET") {
      if (token !== `Bearer ${state.buildsToken ?? TOKEN}`) {
        return failure(403, 10_000, "Invalid token");
      }

      const all = state.builds[decodeURIComponent(builds.groups?.tag ?? "")];

      if (!all) {
        return failure(404, 12_404, "Resource not found");
      }

      return envelope(page(all, url, 200).items);
    }

    const previews = PREVIEWS_PATH.exec(path);

    return previews
      ? previewRoute(method, url, token, previews)
      : failure(400, 7000, "No route for that URI");
  };

  const github = (method: string, url: URL): Response => {
    const route = REPOSITORY_PATH.exec(url.pathname);

    const repository =
      route && state.repositories[route.groups?.repository ?? ""];

    if (method !== "GET" || !route || !repository) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }

    let items: unknown[];

    if (route.groups?.kind === "branches") {
      items = repository.branches.map((name) => ({ name }));
    } else {
      const wanted = url.searchParams.get("state") ?? "open";
      items = repository.pulls.filter(
        (item) => wanted === "all" || item.state === wanted
      );
    }

    const { items: batch, number, perPage } = page(items, url, 100);
    const headers = new Headers();

    if (!state.dropLinks && number * perPage < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(number + 1));
      headers.set("link", `<${next}>; rel="next"`);
    }

    return Response.json(batch, { headers });
  };

  // SAFETY: the fake answers every call the package makes, with the shape `fetch` promises.
  const transport =
    // oxlint-disable-next-line eslint/require-await -- `fetch` answers a promise, and this stands in for it
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.host}${url.pathname}${url.search}`);

      if (url.host === "api.cloudflare.com") {
        return cloudflare(method, url, new Headers(init?.headers));
      }

      if (url.host === "api.github.com") {
        return github(method, url);
      }

      throw new Error(`The fake serves no ${url.host}`);
    }) as typeof fetch;

  return { fetch: transport, calls, state };
};
