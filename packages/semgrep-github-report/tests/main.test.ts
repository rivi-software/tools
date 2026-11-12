import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COMMENT_MARKER } from "../src/index.js";
import type { SemgrepFinding } from "../src/index.js";
import { main, USAGE } from "../src/main.js";

let dir: string;

const finding = (file: string, line: number): SemgrepFinding => ({
  check_id: "example.rule",
  path: file,
  start: { line },
  end: { line },
  extra: {
    message: "Something risky",
    severity: "ERROR",
    fingerprint: "requires login",
  },
});

/** A file with what `semgrep scan --json` writes for these findings. */
const findingsFile = (...results: SemgrepFinding[]): string => {
  const file = path.join(dir, "semgrep-findings.json");

  writeFileSync(
    file,
    JSON.stringify({ version: "1.178.0", results, errors: [] })
  );

  return file;
};

/** The workflow event GitHub Actions wrote, as its own JSON file. */
const eventFile = (event: {
  action?: string;
  number?: number;
  ref?: string;
  pull_request?: {
    number?: unknown;
    head?: { repo: { full_name: string } | null };
  };
  workflow_run?: { pull_requests: unknown[] };
}): string => {
  const file = path.join(dir, "event.json");

  writeFileSync(file, JSON.stringify(event));

  return file;
};

/**
 * What GitHub Actions sets in a job on a pull_request event from a branch of the repository, and
 * the token the step passes.
 */
const pullRequestEnv = () => ({
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_SHA: "abc123",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_EVENT_PATH: eventFile({
    action: "synchronize",
    number: 7,
    pull_request: { number: 7, head: { repo: { full_name: "acme/app" } } },
  }),
  GITHUB_TOKEN: "ghs_example",
});

interface Request {
  method: string;
  url: string;
  authorization: string | null;
  body?: string;
}

/** Answers requests to GitHub with these responses in turn, and records them. */
const stubGitHub = (...responses: Response[]): Request[] => {
  const requests: Request[] = [];

  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    requests.push({
      method: init.method ?? "GET",
      url,
      authorization: new Headers(init.headers).get("Authorization"),
      // SAFETY: the command sends the comment's body and nothing else as JSON.
      body: init.body
        ? (JSON.parse(String(init.body)) as { body: string }).body
        : undefined,
    });

    const response = responses.shift();

    if (!response) {
      throw new Error(`Unexpected request: ${init.method} ${url}`);
    }

    return Promise.resolve(response);
  });

  return requests;
};

/** A comment as GitHub's REST API answers with it, or the error body it answers instead. */
interface CommentResponse {
  id?: number;
  body?: string;
  html_url?: string;
  user?: { login: string; type: string };
  message?: string;
  status?: string;
}

/** The account a job's GITHUB_TOKEN writes comments as. */
const githubActions = { login: "github-actions[bot]", type: "Bot" };

const person = { login: "octocat", type: "User" };

const json = (
  body: CommentResponse | CommentResponse[],
  status = 200
): Response => Response.json(body, { status });

const commentsUrl = "https://api.github.com/repos/acme/app/issues/7/comments";

describe(main, () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "semgrep-github-report-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("--mode pr", () => {
    it("updates the comment that carries the marker, looking past the first 100", async () => {
      const others = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        body: "LGTM",
      }));

      const ours = {
        id: 4242,
        body: `${COMMENT_MARKER}\n## Semgrep findings\n\nOld list`,
        user: githubActions,
      };

      const requests = stubGitHub(
        json(others),
        json([ours]),
        json({
          id: 4242,
          html_url: "https://github.com/acme/app/pull/7#issuecomment-4242",
        })
      );

      const output = await main(
        ["--mode", "pr", "--findings", findingsFile(finding("src/a.ts", 3))],
        pullRequestEnv()
      );

      expect(
        requests.map(({ method, url }) => `${method} ${url}`)
      ).toStrictEqual([
        `GET ${commentsUrl}?per_page=100&page=1`,
        `GET ${commentsUrl}?per_page=100&page=2`,
        "PATCH https://api.github.com/repos/acme/app/issues/comments/4242",
      ]);
      expect(
        requests.every(
          ({ authorization }) => authorization === "Bearer ghs_example"
        )
      ).toBeTruthy();
      expect(requests[2].body).toContain("\n1 finding(s) on `abc123`.\n");
      expect(requests[2].body).toContain(
        "(https://github.com/acme/app/blob/abc123/src/a.ts#L3)"
      );
      expect(output).toBe(
        "Updated https://github.com/acme/app/pull/7#issuecomment-4242 with 1 finding(s)."
      );
    });

    it("comments when there are findings and no comment yet", async () => {
      const requests = stubGitHub(
        json([{ id: 1, body: "LGTM" }]),
        json(
          {
            id: 2,
            html_url: "https://github.com/acme/app/pull/7#issuecomment-2",
          },
          201
        )
      );

      const output = await main(
        [
          "--mode",
          "pr",
          "--findings",
          findingsFile(finding("src/a.ts", 3), finding("src/b.ts", 5)),
        ],
        pullRequestEnv()
      );

      expect(
        requests.map(({ method, url }) => `${method} ${url}`)
      ).toStrictEqual([
        `GET ${commentsUrl}?per_page=100&page=1`,
        `POST ${commentsUrl}`,
      ]);
      expect(requests[1].body).toMatch(
        new RegExp(
          `^${COMMENT_MARKER}\\n## Semgrep findings\\n\\n2 finding\\(s\\) on \`abc123\`\\.`,
          "u"
        )
      );
      expect(output).toBe(
        "Commented https://github.com/acme/app/pull/7#issuecomment-2 with 2 finding(s)."
      );
    });

    it("leaves a pull request without findings or an earlier comment alone", async () => {
      const requests = stubGitHub(json([]));

      const output = await main(
        ["--mode", "pr", "--findings", findingsFile()],
        pullRequestEnv()
      );

      expect(requests).toHaveLength(1);
      expect(output).toBe("No findings, and no comment on #7 to update.");
    });

    it("says the findings are gone in the comment that listed them", async () => {
      const ours = {
        id: 9,
        body: `${COMMENT_MARKER}\n## Semgrep findings\n\nOld list`,
        user: githubActions,
      };

      const requests = stubGitHub(
        json([ours]),
        json({
          id: 9,
          html_url: "https://github.com/acme/app/pull/7#issuecomment-9",
        })
      );

      const output = await main(
        ["--mode", "pr", "--findings", findingsFile()],
        pullRequestEnv()
      );

      expect(requests[1].method).toBe("PATCH");
      expect(requests[1].body).toBe(
        `${COMMENT_MARKER}\n## Semgrep findings\n\nNo new findings on this revision.\n`
      );
      expect(output).toBe(
        "Updated https://github.com/acme/app/pull/7#issuecomment-9 with 0 finding(s)."
      );
    });

    it("updates its own comment, not a person's with the marker before it", async () => {
      const pasted = {
        id: 1,
        body: `${COMMENT_MARKER}\n## Semgrep findings\n\nPasted from the run`,
        user: person,
      };

      const ours = {
        id: 2,
        body: `${COMMENT_MARKER}\n## Semgrep findings\n\nOld list`,
        user: githubActions,
      };

      const requests = stubGitHub(
        json([pasted, ours]),
        json({
          id: 2,
          html_url: "https://github.com/acme/app/pull/7#issuecomment-2",
        })
      );

      const output = await main(
        ["--mode", "pr", "--findings", findingsFile(finding("src/a.ts", 3))],
        pullRequestEnv()
      );

      expect(
        requests.map(({ method, url }) => `${method} ${url}`)
      ).toStrictEqual([
        `GET ${commentsUrl}?per_page=100&page=1`,
        "PATCH https://api.github.com/repos/acme/app/issues/comments/2",
      ]);
      expect(output).toBe(
        "Updated https://github.com/acme/app/pull/7#issuecomment-2 with 1 finding(s)."
      );
    });

    it("comments anew when only a person's comment, or one that quotes the marker, carries it", async () => {
      const pasted = {
        id: 1,
        body: `${COMMENT_MARKER}\n## Semgrep findings\n\nPasted from the run`,
        user: person,
      };

      const quoted = {
        id: 2,
        body: `The report opens with \`${COMMENT_MARKER}\`.`,
        user: githubActions,
      };

      const requests = stubGitHub(
        json([pasted, quoted]),
        json(
          {
            id: 3,
            html_url: "https://github.com/acme/app/pull/7#issuecomment-3",
          },
          201
        )
      );

      const output = await main(
        ["--mode", "pr", "--findings", findingsFile(finding("src/a.ts", 3))],
        pullRequestEnv()
      );

      expect(
        requests.map(({ method, url }) => `${method} ${url}`)
      ).toStrictEqual([
        `GET ${commentsUrl}?per_page=100&page=1`,
        `POST ${commentsUrl}`,
      ]);
      expect(output).toBe(
        "Commented https://github.com/acme/app/pull/7#issuecomment-3 with 1 finding(s)."
      );
    });

    it("updates the comment of the account --author names, in any case", async () => {
      const fromActions = {
        id: 1,
        body: `${COMMENT_MARKER}\n## Semgrep findings\n\nFrom another workflow`,
        user: githubActions,
      };

      const fromApp = {
        id: 2,
        body: `${COMMENT_MARKER}\n## Semgrep findings\n\nOld list`,
        user: { login: "acme-scanner[bot]", type: "Bot" },
      };

      const requests = stubGitHub(
        json([fromActions, fromApp]),
        json({
          id: 2,
          html_url: "https://github.com/acme/app/pull/7#issuecomment-2",
        })
      );

      await main(
        [
          "--mode",
          "pr",
          "--author",
          "Acme-Scanner[bot]",
          "--findings",
          findingsFile(),
        ],
        pullRequestEnv()
      );

      expect(requests[1].method).toBe("PATCH");
      expect(requests[1].url).toBe(
        "https://api.github.com/repos/acme/app/issues/comments/2"
      );
    });

    it("takes the pull request and commit from --pr and --sha, and GitHub's URLs from the environment", async () => {
      const env = {
        ...pullRequestEnv(),
        GITHUB_API_URL: "https://github.example.com/api/v3",
        GITHUB_SERVER_URL: "https://github.example.com",
        GITHUB_EVENT_PATH: eventFile({ workflow_run: { pull_requests: [] } }),
      };

      const requests = stubGitHub(
        json([]),
        json(
          {
            id: 1,
            html_url:
              "https://github.example.com/acme/app/pull/12#issuecomment-1",
          },
          201
        )
      );

      const findings = findingsFile(finding("src/a.ts", 3));
      await main(
        [
          "--mode",
          "pr",
          "--pr",
          "12",
          "--sha",
          "def456",
          "--findings",
          findings,
        ],
        env
      );
      expect(
        requests.map(({ method, url }) => `${method} ${url}`)
      ).toStrictEqual([
        "GET https://github.example.com/api/v3/repos/acme/app/issues/12/comments?per_page=100&page=1",
        "POST https://github.example.com/api/v3/repos/acme/app/issues/12/comments",
      ]);
      expect(requests[1].body).toContain("\n1 finding(s) on `def456`.\n");
      expect(requests[1].body).toContain(
        "(https://github.example.com/acme/app/blob/def456/src/a.ts#L3)"
      );
    });

    it.each([
      { from: "a fork", repo: { full_name: "contributor/app" } },
      { from: "a fork since deleted", repo: null },
    ])(
      "lists the findings of a pull request from $from in the job summary, with no request to GitHub",
      async ({ repo }) => {
        const requests = stubGitHub();
        const summary = path.join(dir, "step-summary.md");

        const env = {
          ...pullRequestEnv(),
          GITHUB_EVENT_PATH: eventFile({
            action: "synchronize",
            number: 7,
            pull_request: { number: 7, head: { repo } },
          }),
          GITHUB_STEP_SUMMARY: summary,
        };

        const output = await main(
          ["--mode", "pr", "--findings", findingsFile(finding("src/a.ts", 3))],
          env
        );

        expect(requests).toHaveLength(0);
        expect(output).toBe(
          "Pull request #7 comes from a fork: listing its findings in the job summary instead of a comment.\n" +
            "Listed 1 finding(s) in the job summary."
        );
        expect(readFileSync(summary, "utf-8")).toBe(
          "## Semgrep findings on `abc123` (1)\n\n" +
            "| Severity | Rule | Location |\n| --- | --- | --- |\n" +
            "| ERROR | `example.rule` | [`src/a.ts:3`](https://github.com/acme/app/blob/abc123/src/a.ts#L3) |\n"
        );
      }
    );

    it("fails when GitHub refuses the comment on a pull request from the repository itself", async () => {
      stubGitHub(
        json([]),
        json(
          { message: "Resource not accessible by integration", status: "403" },
          403
        )
      );
      const findings = findingsFile(finding("src/a.ts", 3));
      await expect(
        main(["--mode", "pr", "--findings", findings], pullRequestEnv())
      ).rejects.toThrow(
        'GitHub API 403 POST /repos/acme/app/issues/7/comments: {"message":"Resource not accessible by integration","status":"403"}\n' +
          "The token may not write comments here: the job needs `pull-requests: write`."
      );
    });

    it("names the request and why it failed when GitHub cannot be reached", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: new Error("connect ECONNREFUSED 127.0.0.1:443"),
          })
        )
      );
      const findings = findingsFile(finding("src/a.ts", 3));
      await expect(
        main(["--mode", "pr", "--findings", findings], pullRequestEnv())
      ).rejects.toThrow(
        `GitHub API GET ${commentsUrl}?per_page=100&page=1: fetch failed (connect ECONNREFUSED 127.0.0.1:443)`
      );
    });

    it("needs a pull request and a token", async () => {
      stubGitHub();
      const env = pullRequestEnv();
      const args = ["--mode", "pr", "--findings", findingsFile()];
      const pushEvent = eventFile({ ref: "refs/heads/main" });
      await expect(
        main(args, { ...env, GITHUB_EVENT_PATH: pushEvent })
      ).rejects.toThrow(
        "No pull request: pass --pr <number>, or run on a pull_request event"
      );
      await expect(
        main(args, { ...env, GITHUB_EVENT_PATH: undefined })
      ).rejects.toThrow("No pull request");
      await expect(main([...args, "--pr", "seven"], env)).rejects.toThrow(
        "Invalid pull request number: seven"
      );
      await expect(
        main(args, { ...pullRequestEnv(), GITHUB_TOKEN: undefined })
      ).rejects.toThrow("Missing required environment variable: GITHUB_TOKEN");
    });

    it("names the event file it cannot read, with --pr too", async () => {
      stubGitHub();
      const missing = path.join(dir, "missing-event.json");
      await expect(
        main(["--mode", "pr", "--pr", "7", "--findings", findingsFile()], {
          ...pullRequestEnv(),
          GITHUB_EVENT_PATH: missing,
        })
      ).rejects.toThrow(
        `Cannot read the workflow event from ${missing} (GITHUB_EVENT_PATH): ENOENT`
      );
    });
  });

  describe("--mode summary", () => {
    it("appends the findings to the job summary", async () => {
      stubGitHub();
      const summary = path.join(dir, "step-summary.md");
      writeFileSync(summary, "## An earlier step\n\n");

      const output = await main(
        [
          "--mode",
          "summary",
          "--findings",
          findingsFile(finding("src/a.ts", 3)),
        ],
        {
          GITHUB_REPOSITORY: "acme/app",
          GITHUB_SHA: "abc123",
          GITHUB_STEP_SUMMARY: summary,
        }
      );

      expect(output).toBe("Listed 1 finding(s) in the job summary.");
      expect(readFileSync(summary, "utf-8")).toBe(
        "## An earlier step\n\n" +
          "## Semgrep findings on `abc123` (1)\n\n" +
          "| Severity | Rule | Location |\n| --- | --- | --- |\n" +
          "| ERROR | `example.rule` | [`src/a.ts:3`](https://github.com/acme/app/blob/abc123/src/a.ts#L3) |\n"
      );
    });

    it("prints them outside GitHub Actions, where --sha names the commit", async () => {
      const output = await main(
        ["--mode", "summary", "--sha", "abc123", "--findings", findingsFile()],
        {
          GITHUB_REPOSITORY: "acme/app",
        }
      );

      expect(output).toBe(
        "## Semgrep findings on `abc123` (0)\n\nNo findings.\n"
      );
      await expect(
        main(["--mode", "summary", "--findings", findingsFile()], {
          GITHUB_REPOSITORY: "acme/app",
        })
      ).rejects.toThrow(
        "Missing required environment variable: GITHUB_SHA (or pass --sha <commit>)"
      );
    });
  });

  describe("arguments", () => {
    it("rejects a missing or unknown mode, unknown options and options without a value", async () => {
      const env = pullRequestEnv();
      await expect(main([], env)).rejects.toThrow(
        /^Invalid --mode \(missing\)\n\nUsage: semgrep-github-report --mode pr\|summary/u
      );
      await expect(main(["--mode", "comment"], env)).rejects.toThrow(
        "Invalid --mode comment"
      );
      await expect(
        main(["--mode", "pr", "--finding", "out.json"], env)
      ).rejects.toThrow("Unknown option '--finding'");
      await expect(main(["--mode", "pr", "--findings"], env)).rejects.toThrow(
        "Option '--findings <value>' argument missing"
      );
      await expect(main(["--mode", "pr", "--author", ""], env)).rejects.toThrow(
        /^Invalid --author: an empty login\n\nUsage:/u
      );
    });

    it("ignores an empty --author in --mode summary, which does not read it", async () => {
      await expect(
        main(
          [
            "--mode",
            "summary",
            "--author",
            "",
            "--sha",
            "abc123",
            "--findings",
            findingsFile(),
          ],
          { GITHUB_REPOSITORY: "acme/app" }
        )
      ).resolves.toBe("## Semgrep findings on `abc123` (0)\n\nNo findings.\n");
    });

    it("prints its help", async () => {
      await expect(main(["--help"], {})).resolves.toBe(USAGE);
      await expect(main(["-h"], {})).resolves.toBe(USAGE);
    });

    it("names the findings file it cannot read", async () => {
      const missing = path.join(dir, "missing.json");
      await expect(
        main(["--mode", "summary", "--findings", missing], pullRequestEnv())
      ).rejects.toThrow(`Cannot read Semgrep findings from ${missing}: ENOENT`);
      const empty = path.join(dir, "empty.json");
      writeFileSync(empty, "");
      await expect(
        main(["--mode", "summary", "--findings", empty], pullRequestEnv())
      ).rejects.toThrow(
        `Cannot read Semgrep findings from ${empty}: Unexpected end of JSON input`
      );
    });
  });
});
