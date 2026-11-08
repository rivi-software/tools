import { describe, expect, it } from "vitest";

import { githubRepository } from "../src/github.js";
import { fakeApis, pull } from "./fake.js";
import type { FakeState } from "./fake.js";

const setup = (
  repository: FakeState["repositories"][string],
  state: Partial<FakeState> = {}
) =>
  fakeApis({
    workers: {},
    builds: {},
    repositories: { "acme/app": repository },
    ...state,
  });

describe(githubRepository, () => {
  it("reads every branch and open pull request, page by page", async () => {
    const branches = [
      "main",
      ...Array.from({ length: 250 }, (_, index) => `b-${index}`),
    ];

    const pulls = Array.from({ length: 130 }, (_, index) =>
      pull(index + 1, `b-${index}`, "open")
    );

    const fake = setup({ branches, pulls });

    const state = await githubRepository({
      repository: "acme/app",
      token: "gh",
      fetch: fake.fetch,
    })();

    expect(state.branches).toStrictEqual(branches);
    expect(state.pullRequests).toHaveLength(130);
    expect(state.pullRequests[0]).toStrictEqual({
      number: 1,
      branch: "b-0",
      open: true,
    });
    expect(
      fake.calls.filter((call) => call.includes("/branches"))
    ).toHaveLength(3);
  });

  it("keeps reading past a full page even when GitHub's Link header is missing", async () => {
    const branches = Array.from({ length: 200 }, (_, index) => `b-${index}`);
    const fake = setup({ branches, pulls: [] }, { dropLinks: true });

    const state = await githubRepository({
      repository: "acme/app",
      fetch: fake.fetch,
    })();

    expect(state.branches).toHaveLength(200);
    expect(
      fake.calls.filter((call) => call.includes("/branches"))
    ).toHaveLength(3);
  });

  it("refuses a branch list it could not read to the end", async () => {
    const branches = Array.from({ length: 10_001 }, (_, index) => `b-${index}`);
    const fake = setup({ branches, pulls: [] });
    await expect(
      githubRepository({ repository: "acme/app", fetch: fake.fetch })()
    ).rejects.toThrow("The branches of acme/app run past 100 pages");
  });

  it("reads only the recently updated closed pull requests, which only keep a Preview longer", async () => {
    const pulls = Array.from({ length: 300 }, (_, index) =>
      pull(index + 1, `b-${index}`, "closed")
    );

    const fake = setup({ branches: ["main"], pulls });

    const state = await githubRepository({
      repository: "acme/app",
      fetch: fake.fetch,
      closedPages: 2,
    })();

    expect(state.pullRequests).toHaveLength(200);
    expect(fake.calls.find((call) => call.includes("state=closed"))).toContain(
      "sort=updated&direction=desc"
    );
  });

  it("marks the pull requests of forks, whose branches are not the repository's", async () => {
    const fake = setup({
      branches: ["main", "fix"],
      pulls: [
        pull(1, "fix", "closed", "someone/app"),
        { number: 2, state: "closed", head: { ref: "fix", repo: null } },
        pull(3, "fix", "open", "Acme/App"),
      ],
    });

    const state = await githubRepository({
      repository: "acme/app",
      fetch: fake.fetch,
    })();

    expect(state.pullRequests).toStrictEqual([
      { number: 3, branch: "fix", open: true },
      { number: 1, branch: "fix", open: false, fork: true },
      { number: 2, branch: "fix", open: false, fork: true },
    ]);
  });

  it("a failed request fails the read, and a repository it cannot see says so", async () => {
    const fake = setup({ branches: ["main"], pulls: [] });
    await expect(
      githubRepository({ repository: "acme/other", fetch: fake.fetch })()
    ).rejects.toThrow(
      "HTTP 404): check the repository's name, and that the token can read it"
    );
    expect(() => githubRepository({ repository: "acme" })).toThrow(
      "owner/name"
    );
  });

  it("sends the token, and talks to GitHub Enterprise Server at its API URL", async () => {
    const seen: { url: string; authorization: string | null }[] = [];

    // SAFETY: the stand-in answers every call this test makes, with the shape `fetch` promises.
    const transport =
      // oxlint-disable-next-line eslint/require-await -- `fetch` answers a promise, and this stands in for it
      (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });

        return Response.json(
          String(input).includes("/branches") ? [{ name: "main" }] : []
        );
      }) as typeof fetch;

    await githubRepository({
      repository: "acme/app",
      token: "gh-token",
      apiUrl: "https://git.example.com/api/v3/",
      fetch: transport,
    })();
    expect(seen[0].url).toBe(
      "https://git.example.com/api/v3/repos/acme/app/branches?per_page=100&page=1"
    );
    expect(
      seen.every((call) => call.authorization === "Bearer gh-token")
    ).toBeTruthy();
  });
});
