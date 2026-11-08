import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { argv } = process;
let dir: string;

/** Loads the bin, as Node does when it runs the command, and waits for what it prints. */
const runBin = async (...args: string[]) => {
  process.argv = [
    process.execPath,
    "/usr/local/bin/semgrep-github-report",
    ...args,
  ];

  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  await import("../src/cli.js");
  await vi.waitFor(() => {
    expect(log.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0);
  });

  return { log, error };
};

describe("the semgrep-github-report command", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "semgrep-github-report-cli-"));
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the command when Node loads it, with no import.meta.main check", async () => {
    const findings = path.join(dir, "semgrep-findings.json");

    writeFileSync(findings, JSON.stringify({ results: [] }));

    const summary = path.join(dir, "step-summary.md");

    vi.stubEnv("GITHUB_REPOSITORY", "acme/app");
    vi.stubEnv("GITHUB_SHA", "abc123");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);

    const { log, error } = await runBin(
      "--mode",
      "summary",
      "--findings",
      findings
    );

    expect(log.mock.calls).toStrictEqual([
      ["Listed 0 finding(s) in the job summary."],
    ]);
    expect(error).not.toHaveBeenCalled();
    expect(readFileSync(summary, "utf-8")).toBe(
      "## Semgrep findings on `abc123` (0)\n\nNo findings.\n"
    );
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("prints what went wrong to stderr and exits 1", async () => {
    const { log, error } = await runBin("--mode", "nonsense");

    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls).toStrictEqual([
      [expect.stringMatching(/^Invalid --mode nonsense\n\nUsage: /u)],
    ]);
    expect(process.exitCode).toBe(1);
  });
});
