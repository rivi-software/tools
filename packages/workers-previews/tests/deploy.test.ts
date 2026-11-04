import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunOptions } from "@rivi-software/cloudflare-deploy";
import { expect, test } from "vitest";
import { deployPreview, readPreviewResult } from "../src/deploy.js";
import { previewName } from "../src/name.js";

const name = previewName("feature/x");
const record = (changes: object = {}) =>
  JSON.stringify({
    type: "preview",
    version: 1,
    worker_name: "app",
    preview_id: "p1",
    preview_name: name,
    preview_slug: name,
    preview_urls: [`https://${name}-app.acme.workers.dev`],
    deployment_id: "d1",
    deployment_urls: ["https://0123abcd-app.acme.workers.dev"],
    timestamp: "2026-11-04T00:00:00.000Z",
    ...changes,
  });

/** A stand-in for Wrangler that appends `lines` to its output file and exits with `code`. */
function wrangler(lines: string[], code = 0) {
  const runs: { args: string[]; options: RunOptions; outputPath?: string; before?: string }[] = [];
  const run = async (args: string[], options: RunOptions) => {
    const outputPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;
    const before = outputPath === undefined ? undefined : readFileSync(outputPath, "utf8");
    runs.push({ args, options, outputPath, before });
    if (outputPath) for (const line of lines) await appendFile(outputPath, `${line}\n`);
    return { code, stdout: "", stderr: "" };
  };
  return { run, runs };
}

test("runs wrangler preview under the branch's name, and reads this run's result", async () => {
  const fake = wrangler([JSON.stringify({ type: "wrangler-session", version: 1 }), record()]);
  const cwd = mkdtempSync(path.join(tmpdir(), "previews-test-"));
  const deployed = await deployPreview({
    branch: "feature/x",
    worker: "app",
    args: ["--config", "dist/server/wrangler.json"],
    cwd,
    env: { PATH: "/usr/bin" },
    run: fake.run,
  });
  expect(deployed).toEqual({
    worker: "app",
    name,
    id: "p1",
    urls: [`https://${name}-app.acme.workers.dev`],
    deploymentId: "d1",
    deploymentUrls: ["https://0123abcd-app.acme.workers.dev"],
  });
  const [run] = fake.runs;
  expect(run.args.slice(1)).toEqual([
    "preview",
    "--name",
    name,
    "--worker-name",
    "app",
    "--config",
    "dist/server/wrangler.json",
  ]);
  expect(run.options.cwd).toBe(cwd);
  expect(run.options.env?.PATH).toBe("/usr/bin");
  // A file of this run's own, empty when Wrangler starts and gone afterwards.
  expect(run.before).toBe("");
  expect(existsSync(run.outputPath!)).toBe(false);
});

test("copies the records to the output file or directory the environment names", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "previews-test-"));
  writeFileSync(path.join(cwd, "earlier.json"), `${JSON.stringify({ type: "deploy" })}\n`);
  const fake = wrangler([record()]);
  await deployPreview({
    branch: "feature/x",
    cwd,
    env: { WRANGLER_OUTPUT_FILE_PATH: "earlier.json" },
    run: fake.run,
  });
  // Wrangler wrote to a file of this run's own, and the caller's file got the record after.
  expect(fake.runs[0].outputPath).not.toBe(path.join(cwd, "earlier.json"));
  expect(readFileSync(path.join(cwd, "earlier.json"), "utf8").trim().split("\n")).toEqual([
    JSON.stringify({ type: "deploy" }),
    record(),
  ]);

  await deployPreview({
    branch: "feature/x",
    cwd,
    env: { WRANGLER_OUTPUT_FILE_DIRECTORY: "out" },
    run: wrangler([record()]).run,
  });
  const files = readdirSync(path.join(cwd, "out"));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^wrangler-output-.+\.json$/);
  expect(readFileSync(path.join(cwd, "out", files[0]), "utf8")).toBe(`${record()}\n`);
});

test("fails when Wrangler fails, or reports no Preview", async () => {
  await expect(
    deployPreview({ branch: "feature/x", run: wrangler([], 1).run, env: {} }),
  ).rejects.toThrow("wrangler preview failed (exit 1)");
  await expect(
    deployPreview({ branch: "feature/x", run: wrangler([]).run, env: {} }),
  ).rejects.toThrow("Expected one Preview in Wrangler's output, found 0");
});

test("refuses the production branch and a name of the caller's, before running Wrangler", async () => {
  const fake = wrangler([record()]);
  await expect(deployPreview({ branch: "main", run: fake.run, env: {} })).rejects.toThrow(
    "production branch",
  );
  for (const args of [["--name", "x"], ["--name=x"], ["--worker-name", "other"]])
    await expect(
      deployPreview({ branch: "feature/x", args, run: fake.run, env: {} }),
    ).rejects.toThrow("Leave --");
  expect(fake.runs).toHaveLength(0);
});

test("accepts only the one record of this Preview and Worker", () => {
  expect(readPreviewResult(record(), { name }).worker).toBe("app");
  expect(readPreviewResult(record({ preview_urls: [] }), { name }).urls).toEqual([]);
  for (const [output, message] of [
    ["", "found 0"],
    [`${record()}\n${record()}`, "found 2"],
    ["Attaching additional modules:", "not JSON"],
    [record({ version: 2 }), "version 2"],
    [record({ preview_name: "b-other-000000000000" }), "not " + name],
    [record({ worker_name: undefined }), "names no Worker"],
  ])
    expect(() => readPreviewResult(output, { name })).toThrow(message);
  expect(() => readPreviewResult(record(), { name, worker: "other" })).toThrow(
    "deployed to the Worker app, not other",
  );
});
