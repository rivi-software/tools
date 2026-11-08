import { mkdtempSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunOptions } from "@rivi-software/cloudflare-deploy";
import { describe, expect, it } from "vitest";

import { previewName } from "../src/name.js";
import { runCli, USAGE } from "../src/run-cli.js";
import { ACCOUNT, fakeApis, preview, pull, TOKEN } from "./fake.js";
import type { FakeState } from "./fake.js";

const TAG = "f".repeat(32);

const world = (changes: Partial<FakeState> = {}) =>
  fakeApis({
    workers: {
      app: {
        tag: TAG,
        previews: [
          preview("main"),
          preview(previewName("feature/live")),
          preview(previewName("feature/merged")),
          preview("feature/merged"),
          preview(previewName("feature/gone"), null),
          preview("pr-3"),
        ],
      },
    },
    builds: { [TAG]: [] },
    repositories: {
      "acme/app": {
        branches: ["main", "feature/live", "feature/merged"],
        pulls: [
          pull(1, "feature/live", "open"),
          pull(2, "feature/merged", "closed"),
          pull(3, "feature/gone", "closed"),
        ],
      },
    },
    ...changes,
  });

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_API_TOKEN: TOKEN,
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_TOKEN: "gh-token",
};

const cli = async (
  args: string[],
  fake: ReturnType<typeof world>,
  env: Record<string, string | undefined> = {},
  run?: (
    args: string[],
    options: RunOptions
  ) => Promise<{ code: number; stdout: string; stderr: string }>
) => {
  const log: string[] = [];
  const error: string[] = [];

  const code = await runCli(args, {
    env: { ...ENV, ...env },
    cwd: tmpdir(),
    log: (line) => log.push(line),
    error: (line) => error.push(line),
    fetch: fake.fetch,
    run,
  });

  return { code, log: log.join("\n"), error: error.join("\n") };
};

const names = (fake: ReturnType<typeof world>) =>
  fake.state.workers.app.previews.map((item) => item.name).toSorted();

/** Git's answer for a checked-out branch, and for a detached HEAD. */
const onBranch = (args: string[]) => {
  expect(args).toStrictEqual([
    "git",
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);

  return Promise.resolve({ code: 0, stdout: "feature/local\n", stderr: "" });
};

const detached = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });

describe("cf-previews", () => {
  it("name prints the branch's Preview name", async () => {
    await expect(
      cli(["name", "--branch", "feature/x"], world())
    ).resolves.toStrictEqual({
      code: 0,
      log: previewName("feature/x"),
      error: "",
    });

    // On a pull request, GitHub Actions names the branch in GITHUB_HEAD_REF.
    const onPull = await cli(["name"], world(), {
      GITHUB_HEAD_REF: "feature/y",
    });

    expect(onPull.log).toBe(previewName("feature/y"));
  });

  it("without --branch or CI variables, the branch is Git's current one", async () => {
    const current = await cli(["name"], world(), {}, onBranch);

    expect(current.log).toBe(previewName("feature/local"));
    await expect(cli(["name"], world(), {}, detached)).resolves.toMatchObject({
      code: 1,
      error: "No branch: pass --branch <name>",
    });
  });

  it("list shows each Preview's branch, last deployment and whether the branch exists", async () => {
    const fake = world();
    const { code, log } = await cli(["list", "--worker", "app"], fake);
    expect(code).toBe(0);
    const rows = log.split("\n").map((row) => row.split(/\s{2,}/u));
    expect(rows[0]).toStrictEqual([
      "Preview",
      "Branch",
      "Last deployment",
      "Branch exists",
    ]);
    expect(rows).toContainEqual([
      previewName("feature/gone"),
      "feature/gone",
      "never",
      "no",
    ]);
    expect(rows).toContainEqual([
      "pr-3",
      "#3 (feature/gone)",
      "2026-11-01T00:00:00Z",
      "no",
    ]);
    expect(rows).toContainEqual([
      previewName("feature/live"),
      "feature/live",
      "2026-11-01T00:00:00Z",
      "yes",
    ]);
  });

  it("list --json gives the same Previews, and deletes nothing", async () => {
    const fake = world();
    const listed = await cli(["list", "--worker", "app", "--json"], fake);

    // SAFETY: the list command prints exactly this shape when --json is given.
    const json = JSON.parse(listed.log) as {
      worker: string;
      previews: unknown[];
    };

    expect(json.worker).toBe("app");
    expect(json.previews).toContainEqual(
      expect.objectContaining({
        name: "feature/merged",
        kind: "raw",
        branchExists: true,
        action: "delete",
      })
    );
    // Listing deletes nothing.
    expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBeFalsy();
  });

  it("sweep without --apply only reports, in the job summary too", async () => {
    const fake = world();

    const summary = path.join(
      mkdtempSync(path.join(tmpdir(), "previews-cli-")),
      "summary.md"
    );

    const { code, log } = await cli(["sweep", "--worker", "app"], fake, {
      GITHUB_STEP_SUMMARY: summary,
    });

    expect(code).toBe(0);
    expect(log).toContain("4 of 6 Previews of app are stale");
    expect(log).toContain(
      "Nothing was deleted: run the sweep with --apply to delete them."
    );
    expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBeFalsy();
    expect(readFileSync(summary, "utf-8")).toContain(
      "### Preview sweep of app (dry run)"
    );
  });

  it("sweep --apply deletes the stale Previews and keeps the live ones", async () => {
    const fake = world();

    const { code, log } = await cli(
      ["sweep", "--worker", "app", "--apply"],
      fake
    );

    expect(code).toBe(0);
    expect(log).toContain("Deleted 4 Previews");
    expect(names(fake)).toStrictEqual(
      ["main", previewName("feature/live")].toSorted()
    );
  });

  it("sweep --apply keeps the pr-<number> Preview of a fork's open pull request", async () => {
    const fake = world();
    fake.state.workers.app.previews.push(preview("pr-4"));
    fake.state.repositories["acme/app"].pulls.push(
      pull(4, "patch-1", "open", "someone/app")
    );

    const { code, log } = await cli(
      ["sweep", "--worker", "app", "--apply"],
      fake
    );

    expect(code).toBe(0);
    expect(log).toMatch(/keep\s+pr-4\s+#4\s+open pull request/u);
    expect(names(fake)).toContain("pr-4");
  });

  it("a sweep carries on past a failed delete, then exits non-zero", async () => {
    const fake = world({
      builds: {
        [TAG]: [
          {
            build_uuid: "b1",
            status: "running",
            build_trigger_metadata: { branch: "feature/merged" },
          },
        ],
      },
    });

    const summary = path.join(
      mkdtempSync(path.join(tmpdir(), "previews-cli-")),
      "summary.md"
    );

    const { code, log, error } = await cli(
      ["sweep", "--worker", "app", "--apply"],
      fake,
      {
        GITHUB_STEP_SUMMARY: summary,
      }
    );

    expect(code).toBe(1);
    expect(readFileSync(summary, "utf-8")).toContain(
      "1 of 3 deletes failed; 2 Previews were deleted\n- Could not delete branch feature/merged: A Workers Build"
    );
    expect(log).toContain(
      "Could not delete branch feature/merged: A Workers Build of feature/merged is running (b1)"
    );
    expect(error).toBe("1 of 3 deletes failed; 2 Previews were deleted");
    expect(names(fake)).toStrictEqual(
      [
        "main",
        previewName("feature/live"),
        previewName("feature/merged"),
        "feature/merged",
      ].toSorted()
    );
  });

  it("sweep refuses to delete anything when GitHub fails", async () => {
    const fake = world();

    const { code, error } = await cli(
      ["sweep", "--worker", "app", "--apply", "--repository", "acme/nope"],
      fake
    );

    expect(code).toBe(1);
    expect(error).toContain(
      "GitHub GET /repos/acme/nope/branches failed (HTTP 404)"
    );
    expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBeFalsy();
  });

  it("delete removes the branch's Preview and the one named after the raw branch", async () => {
    const fake = world();

    const { code, log } = await cli(
      ["delete", "--branch", "feature/merged", "--worker", "app"],
      fake
    );

    expect(code).toBe(0);
    expect(log).toBe(
      `Deleted Preview ${previewName("feature/merged")}\nDeleted Preview feature/merged`
    );

    const again = await cli(
      ["delete", "--branch", "feature/merged", "--worker", "app"],
      fake
    );

    expect(again.log).toBe("No Preview of feature/merged to delete");
  });

  it("delete refuses while a build of the branch runs, unless told to skip the check", async () => {
    const fake = world({
      builds: {
        [TAG]: [
          {
            build_uuid: "b1",
            status: "queued",
            build_trigger_metadata: { branch: "feature/merged" },
          },
        ],
      },
    });

    const refused = await cli(
      ["delete", "--branch", "feature/merged", "--worker", "app"],
      fake
    );

    expect(refused).toMatchObject({
      code: 1,
      error:
        "A Workers Build of feature/merged is queued (b1): wait for it to finish, then delete again",
    });
    expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBeFalsy();

    const skipped = await cli(
      [
        "delete",
        "--branch",
        "feature/merged",
        "--worker",
        "app",
        "--skip-build-check",
      ],
      fake
    );

    expect(skipped.code).toBe(0);
    expect(fake.calls.filter((call) => call.includes("/builds/"))).toHaveLength(
      1
    );
  });

  it("the build check uses CLOUDFLARE_BUILDS_API_TOKEN, and says what to do when it is refused", async () => {
    const fake = world({ buildsToken: "user-token" });

    const refused = await cli(
      ["delete", "--branch", "feature/merged", "--worker", "app"],
      fake
    );

    expect(refused.code).toBe(1);
    expect(refused.error).toContain("set CLOUDFLARE_BUILDS_API_TOKEN");

    const allowed = await cli(
      ["delete", "--branch", "feature/merged", "--worker", "app"],
      fake,
      {
        CLOUDFLARE_BUILDS_API_TOKEN: "user-token",
      }
    );

    expect(allowed.code).toBe(0);
  });

  it("the Worker comes from Workers Builds, and must agree with --worker", async () => {
    const fake = world();

    const env = {
      WRANGLER_CI_OVERRIDE_NAME: "app",
      WORKERS_CI_BRANCH: "feature/merged",
    };

    const deleted = await cli(["delete"], fake, env);

    expect(deleted.code).toBe(0);
    await expect(
      cli(["delete", "--worker", "other"], fake, env)
    ).resolves.toMatchObject({
      code: 1,
      error: expect.stringContaining(
        "is not the Worker Workers Builds is building"
      ),
    });
    await expect(cli(["list"], fake)).resolves.toMatchObject({
      code: 1,
      error: "No Worker: pass --worker <name>",
    });
  });

  it("deploy passes Wrangler's options through and writes the step outputs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "previews-cli-"));
    const outputs = path.join(dir, "outputs");
    const name = previewName("feature/x");
    const url = `https://${name}-app.acme.workers.dev`;
    const runs: string[][] = [];

    const wrangler = async (args: string[], options: RunOptions) => {
      runs.push(args.slice(1));
      const outputPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;

      if (outputPath === undefined) {
        throw new Error("wrangler ran without an output file");
      }

      await appendFile(
        outputPath,
        `${JSON.stringify({ type: "preview", version: 1, worker_name: "app", preview_name: name, preview_urls: [url] })}\n`
      );

      return { code: 0, stdout: "", stderr: "" };
    };

    const { code, log } = await cli(
      [
        "deploy",
        "--branch",
        "feature/x",
        "--",
        "--config",
        "dist/server/wrangler.json",
      ],
      world(),
      { GITHUB_OUTPUT: outputs },
      wrangler
    );

    expect(code).toBe(0);
    expect(log).toBe(`Preview ${name} of feature/x on app\n${url}`);
    expect(runs).toStrictEqual([
      ["preview", "--name", name, "--config", "dist/server/wrangler.json"],
    ]);
    expect(readFileSync(outputs, "utf-8")).toBe(
      `preview_name=${name}\npreview_url=${url}\n`
    );
  });

  it("no command, or one it does not know, exits 2 and prints the usage", async () => {
    const fake = world();
    await expect(cli([], fake)).resolves.toStrictEqual({
      code: 2,
      log: "",
      error: USAGE,
    });
    await expect(cli(["remove"], fake)).resolves.toStrictEqual({
      code: 2,
      log: "",
      error: USAGE,
    });
  });

  it("an option or argument the command does not take exits 2", async () => {
    const fake = world();
    await expect(cli(["list", "--apply"], fake)).resolves.toMatchObject({
      code: 2,
      error: expect.stringContaining("list takes no --apply"),
    });
    await expect(
      cli(["sweep", "--", "--config", "x"], fake)
    ).resolves.toMatchObject({ code: 2 });
    await expect(cli(["list", "--nope"], fake)).resolves.toMatchObject({
      code: 2,
    });
    await expect(cli(["list", "extra"], fake)).resolves.toMatchObject({
      code: 2,
    });
  });

  it("--help prints the usage", async () => {
    await expect(cli(["--help"], world())).resolves.toStrictEqual({
      code: 0,
      log: USAGE,
      error: "",
    });
  });
});
