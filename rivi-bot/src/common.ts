// What the review's scripts share: the GitHub REST API with the token the action is given, and
// how text from a pull request or a model is clipped, fenced and kept from notifying anyone.
// Node built-ins only, run by Node directly.

export type Env = Record<string, string | undefined>;

export type Fetch = typeof fetch;

export interface Label {
  name: string;
  description?: string | null;
}

/** A JSON value, as a request body to GitHub or a tool's arguments carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * GitHub's REST API: `api(method, path, body)` answers with the JSON GitHub documents for that
 * endpoint, typed as the caller names it (`const pull: Pull = await api(…)`); nothing checks it.
 */
export type Api = <Answer>(
  method: string,
  path: string,
  body?: JsonObject
) => Promise<Answer>;

/** What went wrong, from anything thrown. */
export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const clip = (text: string, max: number): string =>
  text.length > max
    ? `${text.slice(0, max)}\n\n[… cut at ${max} characters]`
    : text;

/** A fence longer than any run of backticks in the text, so the text cannot close it early. */
export const fenceFor = (text: string): string => {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/gu)].map((m) => m[0].length)
  );

  return "`".repeat(Math.max(4, longest + 1));
};

/** Break @-mentions outside code with a zero-width space, so model text notifies nobody. */
export const quietMentions = (markdown: string): string =>
  markdown
    .split(/(?<code>```[\s\S]*?```|`[^`\n]*`)/gu)
    .map((part, n) =>
      n % 2
        ? part
        : part.replaceAll(
            /(?<before>^|[^\w`/@])@(?<login>[A-Za-z0-9][A-Za-z0-9-]*)/gu,
            "$1@​$2"
          )
    )
    .join("");

/** `api(method, path, body)` on the repository, or on GitHub's root for a path from `/search`. */
export const githubApi = (env: Env, fetchImpl: Fetch): Api =>
  async function api<Answer>(
    method: string,
    endpoint: string,
    body?: JsonObject
  ): Promise<Answer> {
    const base = endpoint.startsWith("/search/")
      ? "https://api.github.com"
      : `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;

    const response = await fetchImpl(`${base}${endpoint}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      method,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub ${method} ${endpoint} returned HTTP ${response.status}: ${text.slice(0, 500)}`
      );
    }

    // SAFETY: GitHub answers each endpoint with the JSON it documents, which the caller names as
    // Answer, and 204 with no body.
    return (response.status === 204 ? null : await response.json()) as Answer;
  };

/** The most a GitHub list endpoint gives in one page. */
const PAGE_SIZE = 100;

/**
 * Everything a GitHub list endpoint has, in its order (oldest first, for comments), a page at a
 * time: one read gets the first hundred only, and a long pull request has more comments than that.
 */
export const allPages = async <Item>(
  api: Api,
  endpoint: string
): Promise<Item[]> => {
  const items: Item[] = [];
  const join = endpoint.includes("?") ? "&" : "?";

  for (let page = 1; ; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- pagination: the next page is asked for only when this one was full
    const batch: Item[] = await api(
      "GET",
      `${endpoint}${join}per_page=${PAGE_SIZE}&page=${page}`
    );

    items.push(...batch);

    if (batch.length < PAGE_SIZE) {
      return items;
    }
  }
};
