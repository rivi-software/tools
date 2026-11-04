import { mkdtempSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunOptions } from "@rivi-software/cloudflare-deploy";
import { expect, test } from "vitest";
import { previewName } from "../src/name.js";
import { runCli, USAGE } from "../src/run-cli.js";
import { ACCOUNT, fakeApis, preview, pull, TOKEN, type FakeState } from "./fake.js";

const TAG = "f".repeat(32);

function world(changes: Partial<FakeState> = {}) {
  return fakeApis({
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
}

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_API_TOKEN: TOKEN,
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_TOKEN: "gh-token",
};

async function cli(
  args: string[],
  fake: ReturnType<typeof world>,
  env: Record<string, string | undefined> = {},
  run?: (
    args: string[],
    options: RunOptions,
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
) {
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
}

const names = (fake: ReturnType<typeof world>) =>
  fake.state.workers.app.previews.map((item) => item.name).sort();

test("name prints the branch's Preview name", async () => {
  expect(await cli(["name", "--branch", "feature/x"], world())).toEqual({
    code: 0,
    log: previewName("feature/x"),
    error: "",
  });
  // On a pull request, GitHub Actions names the branch in GITHUB_HEAD_REF.
  expect((await cli(["name"], world(), { GITHUB_HEAD_REF: "feature/y" })).log).toBe(
    previewName("feature/y"),
  );
});

test("without --branch or CI variables, the branch is Git's current one", async () => {
  const git = async (args: string[]) => {
    expect(args).toEqual(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
    return { code: 0, stdout: "feature/local\n", stderr: "" };
  };
  expect((await cli(["name"], world(), {}, git)).log).toBe(previewName("feature/local"));
  const detached = async () => ({ code: 1, stdout: "", stderr: "" });
  expect(await cli(["name"], world(), {}, detached)).toMatchObject({
    code: 1,
    error: "No branch: pass --branch <name>",
  });
});

test("list shows each Preview's branch, last deployment and whether the branch exists", async () => {
  const fake = world();
  const { code, log } = await cli(["list", "--worker", "app"], fake);
  expect(code).toBe(0);
  const rows = log.split("\n").map((row) => row.split(/\s{2,}/));
  expect(rows[0]).toEqual(["Preview", "Branch", "Last deployment", "Branch exists"]);
  expect(rows).toContainEqual([previewName("feature/gone"), "feature/gone", "never", "no"]);
  expect(rows).toContainEqual(["pr-3", "#3 (feature/gone)", "2026-11-01T00:00:00Z", "no"]);
  expect(rows).toContainEqual([
    previewName("feature/live"),
    "feature/live",
    "2026-11-01T00:00:00Z",
    "yes",
  ]);

  const json = JSON.parse((await cli(["list", "--worker", "app", "--json"], fake)).log);
  expect(json.worker).toBe("app");
  expect(json.previews).toContainEqual(
    expect.objectContaining({
      name: "feature/merged",
      kind: "raw",
      branchExists: true,
      action: "delete",
    }),
  );
  // Listing deletes nothing.
  expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
});

test("sweep without --apply only reports, in the job summary too", async () => {
  const fake = world();
  const summary = path.join(mkdtempSync(path.join(tmpdir(), "previews-cli-")), "summary.md");
  const { code, log } = await cli(["sweep", "--worker", "app"], fake, {
    GITHUB_STEP_SUMMARY: summary,
  });
  expect(code).toBe(0);
  expect(log).toContain("4 of 6 Previews of app are stale");
  expect(log).toContain("Nothing was deleted: run the sweep with --apply to delete them.");
  expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  expect(readFileSync(summary, "utf8")).toContain("### Preview sweep of app (dry run)");
});

test("sweep --apply deletes the stale Previews and keeps the live ones", async () => {
  const fake = world();
  const { code, log } = await cli(["sweep", "--worker", "app", "--apply"], fake);
  expect(code).toBe(0);
  expect(log).toContain("Deleted 4 Previews");
  expect(names(fake)).toEqual(["main", previewName("feature/live")].sort());
});

test("sweep --apply keeps the pr-<number> Preview of a fork's open pull request", async () => {
  const fake = world();
  fake.state.workers.app.previews.push(preview("pr-4"));
  fake.state.repositories["acme/app"].pulls.push(pull(4, "patch-1", "open", "someone/app"));
  const { code, log } = await cli(["sweep", "--worker", "app", "--apply"], fake);
  expect(code).toBe(0);
  expect(log).toMatch(/keep\s+pr-4\s+#4\s+open pull request/);
  expect(names(fake)).toContain("pr-4");
});

test("a sweep carries on past a failed delete, then exits non-zero", async () => {
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
  const summary = path.join(mkdtempSync(path.join(tmpdir(), "previews-cli-")), "summary.md");
  const { code, log, error } = await cli(["sweep", "--worker", "app", "--apply"], fake, {
    GITHUB_STEP_SUMMARY: summary,
  });
  expect(code).toBe(1);
  expect(readFileSync(summary, "utf8")).toContain(
    "1 of 3 deletes failed; 2 Previews were deleted\n- Could not delete branch feature/merged: A Workers Build",
  );
  expect(log).toContain(
    "Could not delete branch feature/merged: A Workers Build of feature/merged is running (b1)",
  );
  expect(error).toBe("1 of 3 deletes failed; 2 Previews were deleted");
  expect(names(fake)).toEqual(
    ["main", previewName("feature/live"), previewName("feature/merged"), "feature/merged"].sort(),
  );
});

test("sweep refuses to delete anything when GitHub fails", async () => {
  const fake = world();
  const { code, error } = await cli(
    ["sweep", "--worker", "app", "--apply", "--repository", "acme/nope"],
    fake,
  );
  expect(code).toBe(1);
  expect(error).toContain("GitHub GET /repos/acme/nope/branches failed (HTTP 404)");
  expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
});

test("delete removes the branch's Preview and the one named after the raw branch", async () => {
  const fake = world();
  const { code, log } = await cli(
    ["delete", "--branch", "feature/merged", "--worker", "app"],
    fake,
  );
  expect(code).toBe(0);
  expect(log).toBe(
    `Deleted Preview ${previewName("feature/merged")}\nDeleted Preview feature/merged`,
  );
  expect((await cli(["delete", "--branch", "feature/merged", "--worker", "app"], fake)).log).toBe(
    "No Preview of feature/merged to delete",
  );
});

test("delete refuses while a build of the branch runs, unless told to skip the check", async () => {
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
  const refused = await cli(["delete", "--branch", "feature/merged", "--worker", "app"], fake);
  expect(refused).toMatchObject({
    code: 1,
    error:
      "A Workers Build of feature/merged is queued (b1): wait for it to finish, then delete again",
  });
  expect(fake.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  const skipped = await cli(
    ["delete", "--branch", "feature/merged", "--worker", "app", "--skip-build-check"],
    fake,
  );
  expect(skipped.code).toBe(0);
  expect(fake.calls.filter((call) => call.includes("/builds/"))).toHaveLength(1);
});

test("the build check uses CLOUDFLARE_BUILDS_API_TOKEN, and says what to do when it is refused", async () => {
  const fake = world({ buildsToken: "user-token" });
  const refused = await cli(["delete", "--branch", "feature/merged", "--worker", "app"], fake);
  expect(refused.code).toBe(1);
  expect(refused.error).toContain("set CLOUDFLARE_BUILDS_API_TOKEN");
  const allowed = await cli(["delete", "--branch", "feature/merged", "--worker", "app"], fake, {
    CLOUDFLARE_BUILDS_API_TOKEN: "user-token",
  });
  expect(allowed.code).toBe(0);
});

test("the Worker comes from Workers Builds, and must agree with --worker", async () => {
  const fake = world();
  const env = { WRANGLER_CI_OVERRIDE_NAME: "app", WORKERS_CI_BRANCH: "feature/merged" };
  expect((await cli(["delete"], fake, env)).code).toBe(0);
  expect(await cli(["delete", "--worker", "other"], fake, env)).toMatchObject({
    code: 1,
    error: expect.stringContaining("is not the Worker Workers Builds is building"),
  });
  expect(await cli(["list"], fake)).toMatchObject({
    code: 1,
    error: "No Worker: pass --worker <name>",
  });
});

test("deploy passes Wrangler's options through and writes the step outputs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "previews-cli-"));
  const outputs = path.join(dir, "outputs");
  const name = previewName("feature/x");
  const url = `https://${name}-app.acme.workers.dev`;
  const runs: string[][] = [];
  const wrangler = async (args: string[], options: RunOptions) => {
    runs.push(args.slice(1));
    await appendFile(
      options.env!.WRANGLER_OUTPUT_FILE_PATH!,
      `${JSON.stringify({ type: "preview", version: 1, worker_name: "app", preview_name: name, preview_urls: [url] })}\n`,
    );
    return { code: 0, stdout: "", stderr: "" };
  };
  const { code, log } = await cli(
    ["deploy", "--branch", "feature/x", "--", "--config", "dist/server/wrangler.json"],
    world(),
    { GITHUB_OUTPUT: outputs },
    wrangler,
  );
  expect(code).toBe(0);
  expect(log).toBe(`Preview ${name} of feature/x on app\n${url}`);
  expect(runs).toEqual([["preview", "--name", name, "--config", "dist/server/wrangler.json"]]);
  expect(readFileSync(outputs, "utf8")).toBe(`preview_name=${name}\npreview_url=${url}\n`);
});

test("usage errors exit 2 and print the usage", async () => {
  const fake = world();
  expect(await cli([], fake)).toEqual({ code: 2, log: "", error: USAGE });
  expect(await cli(["remove"], fake)).toEqual({ code: 2, log: "", error: USAGE });
  expect(await cli(["list", "--apply"], fake)).toMatchObject({
    code: 2,
    error: expect.stringContaining("list takes no --apply"),
  });
  expect(await cli(["sweep", "--", "--config", "x"], fake)).toMatchObject({ code: 2 });
  expect(await cli(["list", "--nope"], fake)).toMatchObject({ code: 2 });
  expect(await cli(["list", "extra"], fake)).toMatchObject({ code: 2 });
  expect(await cli(["--help"], fake)).toEqual({ code: 0, log: USAGE, error: "" });
});
