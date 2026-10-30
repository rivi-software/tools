import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { COMMENT_MARKER, type SemgrepFinding } from "../src/index.js";
import { main, USAGE } from "../src/main.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "semgrep-github-report-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function finding(path: string, line: number): SemgrepFinding {
  return {
    check_id: "example.rule",
    path,
    start: { line },
    end: { line },
    extra: { message: "Something risky", severity: "ERROR", fingerprint: "requires login" },
  };
}

/** A file with what `semgrep scan --json` writes for these findings. */
function findingsFile(...results: SemgrepFinding[]): string {
  const file = join(dir, "semgrep-findings.json");
  writeFileSync(file, JSON.stringify({ version: "1.178.0", results, errors: [] }));
  return file;
}

function eventFile(event: unknown): string {
  const file = join(dir, "event.json");
  writeFileSync(file, JSON.stringify(event));
  return file;
}

/** What GitHub Actions sets in a job on a pull_request event, and the token the step passes. */
function pullRequestEnv(): Record<string, string | undefined> {
  return {
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_SHA: "abc123",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_EVENT_PATH: eventFile({ action: "synchronize", number: 7, pull_request: { number: 7 } }),
    GITHUB_TOKEN: "ghs_example",
  };
}

type Request = { method: string; url: string; authorization: string | null; body?: string };

/** Answers requests to GitHub with these responses in turn, and records them. */
function stubGitHub(...responses: Response[]): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    requests.push({
      method: init.method ?? "GET",
      url,
      authorization: new Headers(init.headers).get("Authorization"),
      body: init.body ? (JSON.parse(String(init.body)) as { body: string }).body : undefined,
    });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected request: ${init.method} ${url}`);
    return response;
  });
  return requests;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const commentsUrl = "https://api.github.com/repos/acme/app/issues/7/comments";

describe("--mode pr", () => {
  test("updates the comment that carries the marker, looking past the first 100", async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: "LGTM" }));
    const ours = { id: 4242, body: `${COMMENT_MARKER}\n## Semgrep findings\n\nOld list` };
    const requests = stubGitHub(
      json(others),
      json([ours]),
      json({ id: 4242, html_url: "https://github.com/acme/app/pull/7#issuecomment-4242" }),
    );
    const output = await main(
      ["--mode", "pr", "--findings", findingsFile(finding("src/a.ts", 3))],
      pullRequestEnv(),
    );
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${commentsUrl}?per_page=100&page=1`,
      `GET ${commentsUrl}?per_page=100&page=2`,
      "PATCH https://api.github.com/repos/acme/app/issues/comments/4242",
    ]);
    expect(requests.every(({ authorization }) => authorization === "Bearer ghs_example")).toBe(
      true,
    );
    expect(requests[2].body).toContain("\n1 finding(s) on `abc123`.\n");
    expect(requests[2].body).toContain("(https://github.com/acme/app/blob/abc123/src/a.ts#L3)");
    expect(output).toBe(
      "Updated https://github.com/acme/app/pull/7#issuecomment-4242 with 1 finding(s).",
    );
  });

  test("comments when there are findings and no comment yet", async () => {
    const requests = stubGitHub(
      json([{ id: 1, body: "LGTM" }]),
      json({ id: 2, html_url: "https://github.com/acme/app/pull/7#issuecomment-2" }, 201),
    );
    const output = await main(
      ["--mode", "pr", "--findings", findingsFile(finding("src/a.ts", 3), finding("src/b.ts", 5))],
      pullRequestEnv(),
    );
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${commentsUrl}?per_page=100&page=1`,
      `POST ${commentsUrl}`,
    ]);
    expect(requests[1].body).toMatch(
      new RegExp(`^${COMMENT_MARKER}\\n## Semgrep findings\\n\\n2 finding\\(s\\) on \`abc123\`\\.`),
    );
    expect(output).toBe(
      "Commented https://github.com/acme/app/pull/7#issuecomment-2 with 2 finding(s).",
    );
  });

  test("leaves a pull request without findings or an earlier comment alone", async () => {
    const requests = stubGitHub(json([]));
    const output = await main(["--mode", "pr", "--findings", findingsFile()], pullRequestEnv());
    expect(requests).toHaveLength(1);
    expect(output).toBe("No findings, and no comment on #7 to update.");
  });

  test("says the findings are gone in the comment that listed them", async () => {
    const ours = { id: 9, body: `${COMMENT_MARKER}\n## Semgrep findings\n\nOld list` };
    const requests = stubGitHub(
      json([ours]),
      json({ id: 9, html_url: "https://github.com/acme/app/pull/7#issuecomment-9" }),
    );
    const output = await main(["--mode", "pr", "--findings", findingsFile()], pullRequestEnv());
    expect(requests[1].method).toBe("PATCH");
    expect(requests[1].body).toBe(
      `${COMMENT_MARKER}\n## Semgrep findings\n\nNo new findings on this revision.\n`,
    );
    expect(output).toBe(
      "Updated https://github.com/acme/app/pull/7#issuecomment-9 with 0 finding(s).",
    );
  });

  test("takes the pull request and commit from --pr and --sha, and GitHub's URLs from the environment", async () => {
    const env = {
      ...pullRequestEnv(),
      GITHUB_API_URL: "https://github.example.com/api/v3",
      GITHUB_SERVER_URL: "https://github.example.com",
      GITHUB_EVENT_PATH: eventFile({ workflow_run: { pull_requests: [] } }),
    };
    const requests = stubGitHub(
      json([]),
      json({ id: 1, html_url: "https://github.example.com/acme/app/pull/12#issuecomment-1" }, 201),
    );
    const findings = findingsFile(finding("src/a.ts", 3));
    await main(["--mode", "pr", "--pr", "12", "--sha", "def456", "--findings", findings], env);
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://github.example.com/api/v3/repos/acme/app/issues/12/comments?per_page=100&page=1",
      "POST https://github.example.com/api/v3/repos/acme/app/issues/12/comments",
    ]);
    expect(requests[1].body).toContain("\n1 finding(s) on `def456`.\n");
    expect(requests[1].body).toContain(
      "(https://github.example.com/acme/app/blob/def456/src/a.ts#L3)",
    );
  });

  test("explains a refused comment: no pull-requests: write, or a fork's read-only token", async () => {
    stubGitHub(
      json([]),
      json({ message: "Resource not accessible by integration", status: "403" }, 403),
    );
    const findings = findingsFile(finding("src/a.ts", 3));
    await expect(main(["--mode", "pr", "--findings", findings], pullRequestEnv())).rejects.toThrow(
      'GitHub API 403 POST /repos/acme/app/issues/7/comments: {"message":"Resource not accessible by integration","status":"403"}\n' +
        "The token may not write comments here. The job needs `pull-requests: write`, and a pull " +
        "request from a fork gets a read-only token whatever the workflow asks for: list its " +
        "findings with --mode summary instead.",
    );
  });

  test("names the request and why it failed when GitHub cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:443"),
      });
    });
    const findings = findingsFile(finding("src/a.ts", 3));
    await expect(main(["--mode", "pr", "--findings", findings], pullRequestEnv())).rejects.toThrow(
      `GitHub API GET ${commentsUrl}?per_page=100&page=1: fetch failed (connect ECONNREFUSED 127.0.0.1:443)`,
    );
  });

  test("needs a pull request and a token", async () => {
    stubGitHub();
    const env = pullRequestEnv();
    const args = ["--mode", "pr", "--findings", findingsFile()];
    const pushEvent = eventFile({ ref: "refs/heads/main" });
    await expect(main(args, { ...env, GITHUB_EVENT_PATH: pushEvent })).rejects.toThrow(
      "No pull request: pass --pr <number>, or run on a pull_request event",
    );
    await expect(main(args, { ...env, GITHUB_EVENT_PATH: undefined })).rejects.toThrow(
      "No pull request",
    );
    await expect(main([...args, "--pr", "seven"], env)).rejects.toThrow(
      "Invalid pull request number: seven",
    );
    await expect(main(args, { ...env, GITHUB_TOKEN: undefined })).rejects.toThrow(
      "Missing required environment variable: GITHUB_TOKEN",
    );
  });
});

describe("--mode summary", () => {
  test("appends the findings to the job summary", async () => {
    stubGitHub();
    const summary = join(dir, "step-summary.md");
    writeFileSync(summary, "## An earlier step\n\n");
    const output = await main(
      ["--mode", "summary", "--findings", findingsFile(finding("src/a.ts", 3))],
      { GITHUB_REPOSITORY: "acme/app", GITHUB_SHA: "abc123", GITHUB_STEP_SUMMARY: summary },
    );
    expect(output).toBe("Listed 1 finding(s) in the job summary.");
    expect(readFileSync(summary, "utf8")).toBe(
      "## An earlier step\n\n" +
        "## Semgrep findings on `abc123` (1)\n\n" +
        "| Severity | Rule | Location |\n| --- | --- | --- |\n" +
        "| ERROR | `example.rule` | [`src/a.ts:3`](https://github.com/acme/app/blob/abc123/src/a.ts#L3) |\n",
    );
  });

  test("prints them outside GitHub Actions, where --sha names the commit", async () => {
    const output = await main(
      ["--mode", "summary", "--sha", "abc123", "--findings", findingsFile()],
      {
        GITHUB_REPOSITORY: "acme/app",
      },
    );
    expect(output).toBe("## Semgrep findings on `abc123` (0)\n\nNo findings.\n");
    await expect(
      main(["--mode", "summary", "--findings", findingsFile()], { GITHUB_REPOSITORY: "acme/app" }),
    ).rejects.toThrow("Missing required environment variable: GITHUB_SHA (or pass --sha <commit>)");
  });
});

describe("arguments", () => {
  test("rejects a missing or unknown mode, unknown options and options without a value", async () => {
    const env = pullRequestEnv();
    await expect(main([], env)).rejects.toThrow(
      /^Invalid --mode \(missing\)\n\nUsage: semgrep-github-report --mode pr\|summary/,
    );
    await expect(main(["--mode", "comment"], env)).rejects.toThrow("Invalid --mode comment");
    await expect(main(["--mode", "pr", "--finding", "out.json"], env)).rejects.toThrow(
      "Unknown option '--finding'",
    );
    await expect(main(["--mode", "pr", "--findings"], env)).rejects.toThrow(
      "Option '--findings <value>' argument missing",
    );
  });

  test("prints its help", async () => {
    await expect(main(["--help"], {})).resolves.toBe(USAGE);
    await expect(main(["-h"], {})).resolves.toBe(USAGE);
  });

  test("names the findings file it cannot read", async () => {
    const missing = join(dir, "missing.json");
    await expect(
      main(["--mode", "summary", "--findings", missing], pullRequestEnv()),
    ).rejects.toThrow(`Cannot read Semgrep findings from ${missing}: ENOENT`);
    const empty = join(dir, "empty.json");
    writeFileSync(empty, "");
    await expect(
      main(["--mode", "summary", "--findings", empty], pullRequestEnv()),
    ).rejects.toThrow(`Cannot read Semgrep findings from ${empty}: Unexpected end of JSON input`);
  });
});
