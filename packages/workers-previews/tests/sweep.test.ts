import { describe, expect, it } from "vitest";

import { previewName } from "../src/name.js";
import { planSweep, previewOwner } from "../src/sweep.js";
import type { RepositoryState } from "../src/sweep.js";

const repository: RepositoryState = {
  branches: ["main", "rt-1", "feature/open", "wip"],
  pullRequests: [
    { number: 1, branch: "rt-1", open: false },
    { number: 2, branch: "feature/open", open: true },
    { number: 3, branch: "gone/branch", open: false },
    { number: 7, branch: "old", open: false },
    { number: 8, branch: "feature/open", open: true },
  ],
};

/** The Previews the full sweep below works on. */
const PREVIEWS = [
  previewName("rt-1"),
  "rt-1",
  previewName("feature/open"),
  "feature/open",
  "wip",
  "gone/branch",
  previewName("never-seen"),
  "pr-7",
  "pr-8",
  "main",
  previewName("gone/branch"),
];

describe("the sweep of a Worker's Previews", () => {
  it("reads a hashed name back to the branch or pull request it came from", () => {
    expect(previewOwner(previewName("rt-1"), repository)).toStrictEqual({
      kind: "hashed",
      branch: "rt-1",
    });
    // A deleted branch is still known through the head of its pull request.
    expect(previewOwner(previewName("gone/branch"), repository)).toStrictEqual({
      kind: "hashed",
      branch: "gone/branch",
    });
    expect(previewOwner(previewName("never-seen"), repository)).toStrictEqual({
      kind: "hashed",
    });
  });

  it("takes any other name as a branch, a pull request or the production branch", () => {
    expect(previewOwner("rt-1", repository)).toStrictEqual({
      kind: "raw",
      branch: "rt-1",
    });
    expect(previewOwner("pr-7", repository)).toStrictEqual({
      kind: "pull-request",
      number: 7,
      branch: "old",
    });
    expect(previewOwner("pr-99", repository)).toStrictEqual({
      kind: "pull-request",
      number: 99,
    });
    expect(previewOwner("main", repository)).toStrictEqual({
      kind: "production",
      branch: "main",
    });
    expect(
      previewOwner("trunk", repository, { productionBranch: "trunk" })
    ).toStrictEqual({
      kind: "production",
      branch: "trunk",
    });
  });

  it("a branch that merely looks like a hashed name is its own raw Preview", () => {
    const branch = "b-featur-0123456789ab";
    const state = { ...repository, branches: [...repository.branches, branch] };
    expect(previewOwner(branch, state)).toStrictEqual({ kind: "raw", branch });
    const plan = planSweep([branch], state);
    expect(plan.entries[0]).toMatchObject({
      action: "keep",
      reason: "branch has no pull request",
    });
  });

  it("deletes the Previews of deleted branches and closed pull requests, and keeps live work", () => {
    const { entries, targets } = planSweep(PREVIEWS, repository);
    expect(
      Object.fromEntries(
        entries.map((entry) => [entry.name, [entry.action, entry.reason]])
      )
    ).toStrictEqual({
      [previewName("rt-1")]: [
        "delete",
        "every pull request from the branch is closed",
      ],
      "rt-1": ["delete", "every pull request from the branch is closed"],
      [previewName("feature/open")]: ["keep", "open pull request"],
      "feature/open": ["keep", "open pull request"],
      wip: ["keep", "branch has no pull request"],
      "gone/branch": ["delete", "branch deleted"],
      [previewName("gone/branch")]: ["delete", "branch deleted"],
      [previewName("never-seen")]: [
        "delete",
        "no live branch or pull request has this name",
      ],
      "pr-7": ["delete", "pull request closed"],
      "pr-8": ["keep", "open pull request"],
      main: ["keep", "production branch"],
    });
    // One delete per stale branch covers both of its Previews.
    expect(targets).toStrictEqual(
      expect.arrayContaining([
        { branch: "rt-1" },
        { branch: "gone/branch" },
        { name: previewName("never-seen"), builds: "all" },
        { name: "pr-7", builds: "none" },
      ])
    );
    expect(targets).toHaveLength(4);
  });

  it("says whether each Preview's branch still exists, and nothing when it has none", () => {
    const { entries } = planSweep(PREVIEWS, repository);
    expect(entries.find((entry) => entry.name === "wip")).toMatchObject({
      branchExists: true,
    });
    expect(entries.find((entry) => entry.name === "gone/branch")).toMatchObject(
      { branchExists: false }
    );
    expect(
      entries.find((entry) => entry.name === previewName("never-seen"))
    ).not.toHaveProperty("branchExists");
  });

  it("a Preview kept by name is never deleted, not even as its branch's other Preview", () => {
    const { entries, targets } = planSweep(
      ["gone/branch", "demo"],
      repository,
      { keep: ["demo"] }
    );

    expect(entries.find((entry) => entry.name === "demo")).toMatchObject({
      action: "keep",
      reason: "kept by name",
    });
    expect(targets).toStrictEqual([{ branch: "gone/branch" }]);
  });

  it("a fork's pull request keeps its pr-<number> Preview while open, and no other", () => {
    const state: RepositoryState = {
      branches: ["main", "wip"],
      pullRequests: [
        { number: 20, branch: "patch-1", open: true, fork: true },
        { number: 21, branch: "patch-2", open: false, fork: true },
        // A fork's branch named like one of the repository's own.
        { number: 22, branch: "gone/branch", open: true, fork: true },
        { number: 23, branch: "wip", open: false, fork: true },
      ],
    };

    expect(previewOwner("pr-20", state)).toStrictEqual({
      kind: "pull-request",
      number: 20,
    });

    const { entries } = planSweep(
      ["pr-20", "pr-21", "pr-22", "gone/branch", previewName("patch-1"), "wip"],
      state
    );

    expect(
      Object.fromEntries(
        entries.map((entry) => [entry.name, [entry.action, entry.reason]])
      )
    ).toStrictEqual({
      "pr-20": ["keep", "open pull request"],
      "pr-21": ["delete", "pull request closed"],
      "pr-22": ["keep", "open pull request"],
      "gone/branch": ["delete", "branch deleted"],
      [previewName("patch-1")]: [
        "delete",
        "no live branch or pull request has this name",
      ],
      wip: ["keep", "branch has no pull request"],
    });
    expect(entries.find((entry) => entry.name === "pr-20")).not.toHaveProperty(
      "branchExists"
    );
  });

  it("refuses a branch list without the production branch", () => {
    expect(() =>
      planSweep(["rt-1"], { branches: [], pullRequests: [] })
    ).toThrow("do not include the production branch main");
    expect(() =>
      planSweep(["rt-1"], repository, { productionBranch: "trunk" })
    ).toThrow("trunk");
  });

  it("another production branch keeps its own Preview, and a branch named main is any other branch", () => {
    const state = { branches: ["trunk", "main"], pullRequests: [] };

    const { entries } = planSweep(
      ["trunk", previewName("main", { productionBranch: "trunk" })],
      state,
      {
        productionBranch: "trunk",
      }
    );

    expect(
      entries.map((entry) => [
        entry.name,
        entry.kind,
        entry.action,
        entry.reason,
      ])
    ).toStrictEqual([
      [
        previewName("main", { productionBranch: "trunk" }),
        "hashed",
        "keep",
        "branch has no pull request",
      ],
      ["trunk", "production", "keep", "production branch"],
    ]);
  });
});
