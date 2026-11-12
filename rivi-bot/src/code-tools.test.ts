import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { checkoutFile, codeTools, realFile, safePath } from "./code-tools.ts";
import type { CodeTools } from "./code-tools.ts";
import type { Api } from "./common.ts";

/** A checkout with tracked files, a secret file and symlinks out of it and onto the secret. */
const checkout = () => {
  const root = mkdtempSync(path.join(tmpdir(), "code-tools-"));

  const outside = path.join(
    mkdtempSync(path.join(tmpdir(), "outside-")),
    "environ"
  );

  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src/total.ts"),
    "export const total = (xs: number[]) =>\n  xs.reduce((a, b) => a + b, 0);\n"
  );
  writeFileSync(path.join(root, "README.md"), "# Totals\n");
  writeFileSync(path.join(root, ".env"), "API_KEY=dev_secret\n");
  writeFileSync(outside, "GITHUB_TOKEN=ghs_secret\n");
  symlinkSync(outside, path.join(root, "environ"));
  symlinkSync("../.env", path.join(root, "src/settings.ts"));
  execFileSync("git", ["-C", root, "init", "--quiet"]);
  execFileSync("git", ["-C", root, "add", "--all"]);

  return root;
};

describe("a path", () => {
  const root = "/checkout";

  it("stays inside the checkout, as written from its root", () => {
    expect(
      [
        "src/x.ts",
        "./src/x.ts",
        "/src/x.ts",
        "src/../README.md",
        undefined,
      ].map((given) => safePath(root, given))
    ).toStrictEqual(["src/x.ts", "src/x.ts", "src/x.ts", "README.md", "."]);
  });

  it("is refused outside the checkout, or onto a secret or git's own files", () => {
    const refusals = [
      "..",
      "../x",
      "src/../../x",
      ".env",
      "app/.env.local",
      ".dev.vars",
      ".git/config",
    ].map((bad) => {
      try {
        return safePath(root, bad);
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    });

    expect(refusals).toStrictEqual([
      ".. is outside the repository.",
      "../x is outside the repository.",
      "src/../../x is outside the repository.",
      ".env is not readable.",
      "app/.env.local is not readable.",
      ".dev.vars is not readable.",
      ".git/config is not readable.",
    ]);
  });

  it("is followed through a symlink, which must land inside the checkout and off the secrets", () => {
    const repo = checkout();

    expect(realFile(repo, "src/total.ts")).toMatch(/src\/total\.ts$/u);
    expect(realFile(repo, "src/missing.ts")).toBeNull();
    expect(() => realFile(repo, "environ")).toThrow(/outside the repository/u);
    expect(() => realFile(repo, "src/settings.ts")).toThrow(/not readable/u);
  });

  it("reads as no file for what the model is given unasked, when it leads out or onto a secret", () => {
    const repo = checkout();
    const read = checkoutFile(repo);

    expect(read("README.md")).toBe("# Totals\n");
    expect([
      read("environ"),
      read("src/settings.ts"),
      read("src"),
    ]).toStrictEqual([null, null, null]);
  });
});

describe("the code tools", () => {
  let tools: CodeTools;
  const asked: string[] = [];

  const api: Api = <Answer>(method: string, endpoint: string) => {
    asked.push(`${method} ${endpoint}`);

    const answer = endpoint.startsWith("/search/")
      ? {
          // A query can name another repository in ways the hint misses; its results are dropped.
          items: [
            {
              number: 3,
              repository_url: "https://api.github.com/repos/o/r",
              state: "open",
              title: "Totals overflow",
            },
            {
              number: 9,
              repository_url: "https://api.github.com/repos/o/private",
              state: "open",
              title: "Private plans",
            },
          ],
        }
      : {
          body: "Steps.",
          labels: [],
          number: 3,
          state: "open",
          title: "Totals overflow",
        };

    // SAFETY: the tools read only the fields these fakes give, as GitHub answers them.
    return Promise.resolve(answer as Answer);
  };

  beforeAll(() => {
    tools = codeTools(checkout(), api, { repo: "o/r" });
  });

  it("search the tracked files, but never a secret file", async () => {
    await expect(
      tools.call("search_code", { pattern: "reduce" })
    ).resolves.toBe("src/total.ts:2:  xs.reduce((a, b) => a + b, 0);");
    await expect(
      tools.call("search_code", { pattern: "secret" })
    ).resolves.toBe("No matches.");
  });

  it("read a file's lines, numbered, and list the files", async () => {
    await expect(
      tools.call("read_file", { path: "src/total.ts", start_line: 2 })
    ).resolves.toBe(
      "src/total.ts lines 2-3 of 3\n2:   xs.reduce((a, b) => a + b, 0);\n3: "
    );
    await expect(tools.call("list_files", { path: "src" })).resolves.toBe(
      "src/settings.ts\nsrc/total.ts"
    );
  });

  it("refuse a secret, a symlink out of the checkout, and an unknown tool", async () => {
    await expect(
      Promise.all([
        tools.call("read_file", { path: ".env" }),
        tools.call("read_file", { path: "environ" }),
        tools.call("read_file", { path: "src/settings.ts" }),
        tools.call("run_tests", {}),
      ])
    ).resolves.toStrictEqual([
      "Error: .env is not readable.",
      "Error: environ is outside the repository.",
      "Error: src/settings.ts is not readable.",
      "Unknown tool run_tests.",
    ]);
  });

  it("search and read this repository's issues, and no other's", async () => {
    await expect(
      tools.call("search_issues", { query: "totals" })
    ).resolves.toBe("#3 [open] Totals overflow");
    await expect(tools.call("read_issue", { number: 3 })).resolves.toBe(
      "#3 [open] Totals overflow\nLabels: none\n\nSteps."
    );
    await expect(
      tools.call("search_issues", { query: "totals repo:o/private" })
    ).resolves.toMatch(/^Search this repository only/u);
    // Past the hint, as `OR (repo:…)`, another repository's results are still dropped.
    await expect(
      tools.call("search_issues", { query: "totals OR (repo:o/private plans)" })
    ).resolves.toBe("#3 [open] Totals overflow");
    expect(asked).toStrictEqual([
      `GET /search/issues?per_page=10&q=${encodeURIComponent("repo:o/r totals")}`,
      "GET /issues/3",
      `GET /search/issues?per_page=10&q=${encodeURIComponent("repo:o/r totals OR (repo:o/private plans)")}`,
    ]);
  });
});
