import { expect, test } from "vitest";
import { previewName } from "../src/name.js";
import { planSweep, previewOwner, type RepositoryState } from "../src/sweep.js";

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

test("each Preview's owner comes from its name", () => {
  expect(previewOwner(previewName("rt-1"), repository)).toEqual({ kind: "hashed", branch: "rt-1" });
  // A deleted branch is still known through the head of its pull request.
  expect(previewOwner(previewName("gone/branch"), repository)).toEqual({
    kind: "hashed",
    branch: "gone/branch",
  });
  expect(previewOwner(previewName("never-seen"), repository)).toEqual({ kind: "hashed" });
  expect(previewOwner("rt-1", repository)).toEqual({ kind: "raw", branch: "rt-1" });
  expect(previewOwner("pr-7", repository)).toEqual({
    kind: "pull-request",
    number: 7,
    branch: "old",
  });
  expect(previewOwner("pr-99", repository)).toEqual({ kind: "pull-request", number: 99 });
  expect(previewOwner("main", repository)).toEqual({ kind: "production", branch: "main" });
  expect(previewOwner("trunk", repository, { productionBranch: "trunk" })).toEqual({
    kind: "production",
    branch: "trunk",
  });
});

test("a branch that merely looks like a hashed name is its own raw Preview", () => {
  const branch = "b-featur-0123456789ab";
  const state = { ...repository, branches: [...repository.branches, branch] };
  expect(previewOwner(branch, state)).toEqual({ kind: "raw", branch });
  const plan = planSweep([branch], state);
  expect(plan.entries[0]).toMatchObject({ action: "keep", reason: "branch has no pull request" });
});

test("the sweep deletes the Previews of deleted branches and closed pull requests, and keeps live work", () => {
  const previews = [
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
  const { entries, targets } = planSweep(previews, repository);
  expect(
    Object.fromEntries(entries.map((entry) => [entry.name, [entry.action, entry.reason]])),
  ).toEqual({
    [previewName("rt-1")]: ["delete", "every pull request from the branch is closed"],
    "rt-1": ["delete", "every pull request from the branch is closed"],
    [previewName("feature/open")]: ["keep", "open pull request"],
    "feature/open": ["keep", "open pull request"],
    wip: ["keep", "branch has no pull request"],
    "gone/branch": ["delete", "branch deleted"],
    [previewName("gone/branch")]: ["delete", "branch deleted"],
    [previewName("never-seen")]: ["delete", "no live branch or pull request has this name"],
    "pr-7": ["delete", "pull request closed"],
    "pr-8": ["keep", "open pull request"],
    main: ["keep", "production branch"],
  });
  // One delete per stale branch covers both of its Previews.
  expect(targets).toEqual(
    expect.arrayContaining([
      { branch: "rt-1" },
      { branch: "gone/branch" },
      { name: previewName("never-seen"), builds: "all" },
      { name: "pr-7", builds: "none" },
    ]),
  );
  expect(targets).toHaveLength(4);
  expect(entries.find((entry) => entry.name === "wip")).toMatchObject({ branchExists: true });
  expect(entries.find((entry) => entry.name === "gone/branch")).toMatchObject({
    branchExists: false,
  });
  expect(entries.find((entry) => entry.name === previewName("never-seen"))).not.toHaveProperty(
    "branchExists",
  );
});

test("a Preview kept by name is never deleted, not even as its branch's other Preview", () => {
  const { entries, targets } = planSweep(["gone/branch", "demo"], repository, {
    keep: ["demo"],
  });
  expect(entries.find((entry) => entry.name === "demo")).toMatchObject({
    action: "keep",
    reason: "kept by name",
  });
  expect(targets).toEqual([{ branch: "gone/branch" }]);
});

test("the sweep refuses a branch list without the production branch", () => {
  expect(() => planSweep(["rt-1"], { branches: [], pullRequests: [] })).toThrow(
    "do not include the production branch main",
  );
  expect(() => planSweep(["rt-1"], repository, { productionBranch: "trunk" })).toThrow("trunk");
});

test("another production branch keeps its own Preview, and a branch named main is any other branch", () => {
  const state = { branches: ["trunk", "main"], pullRequests: [] };
  const { entries } = planSweep(
    ["trunk", previewName("main", { productionBranch: "trunk" })],
    state,
    {
      productionBranch: "trunk",
    },
  );
  expect(entries.map((entry) => [entry.name, entry.kind, entry.action, entry.reason])).toEqual([
    [
      previewName("main", { productionBranch: "trunk" }),
      "hashed",
      "keep",
      "branch has no pull request",
    ],
    ["trunk", "production", "keep", "production branch"],
  ]);
});
