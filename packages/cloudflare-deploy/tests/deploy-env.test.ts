import { describe, expect, test } from "vitest";
import {
  assertProductionBuildBranch,
  requireCloudflareAccountId,
  requireEnv,
  requireEnvMinLength,
} from "../src/index.js";

describe("requireEnv", () => {
  test("returns a set value and rejects missing or empty ones", () => {
    expect(requireEnv("A", { A: "x" })).toBe("x");
    expect(() => requireEnv("A", {})).toThrow("Missing required environment variable: A");
    expect(() => requireEnv("A", { A: "" })).toThrow("Missing required environment variable: A");
  });

  test("requireEnvMinLength enforces the minimum", () => {
    expect(requireEnvMinLength("S", 3, { S: "abc" })).toBe("abc");
    expect(() => requireEnvMinLength("S", 3, { S: "ab" })).toThrow("at least 3 characters");
  });
});

describe("requireCloudflareAccountId", () => {
  test("accepts a 32-character lowercase hex id and rejects anything else", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(requireCloudflareAccountId({ CLOUDFLARE_ACCOUNT_ID: id })).toBe(id);
    expect(() => requireCloudflareAccountId({ CLOUDFLARE_ACCOUNT_ID: id.toUpperCase() })).toThrow(
      "32 lowercase hexadecimal",
    );
    expect(() => requireCloudflareAccountId({ CLOUDFLARE_ACCOUNT_ID: "short" })).toThrow();
  });
});

describe("assertProductionBuildBranch", () => {
  test("accepts a main push or manual run on GitHub Actions", () => {
    expect(() =>
      assertProductionBuildBranch({
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "push",
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionBuildBranch({
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch",
      }),
    ).not.toThrow();
  });

  test("rejects pull requests, other branches and non-main Workers Builds", () => {
    expect(() =>
      assertProductionBuildBranch({
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/pull/1/merge",
        GITHUB_EVENT_NAME: "pull_request",
      }),
    ).toThrow("main push or manual main run");
    expect(() =>
      assertProductionBuildBranch({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "feature" }),
    ).toThrow("WORKERS_CI_BRANCH=main");
    expect(() => assertProductionBuildBranch({})).not.toThrow();
  });

  test("guards another production branch when given one", () => {
    const push = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" };
    expect(() =>
      assertProductionBuildBranch({ ...push, GITHUB_REF: "refs/heads/release" }, "release"),
    ).not.toThrow();
    expect(() =>
      assertProductionBuildBranch({ ...push, GITHUB_REF: "refs/heads/main" }, "release"),
    ).toThrow("release push or manual release run");
    expect(() =>
      assertProductionBuildBranch({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" }, "release"),
    ).toThrow("WORKERS_CI_BRANCH=release");
  });
});
