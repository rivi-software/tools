import { expect, test } from "vitest";
import { MAX_LABEL_LENGTH, isPreviewName, previewName } from "../src/name.js";

test("a branch keeps the name it had before, so its Preview is updated rather than replaced", () => {
  // Fixed values: a change here renames every Preview a project already has.
  expect(previewName("feature/News")).toBe("b-featur-dbec97bc6ac2");
  expect(previewName("rt-1")).toBe("b-rt-1-a33d8c625833");
  expect(previewName("///")).toBe("b-branch-732c4e971163");
});

test("branches that make the same slug still get different names", () => {
  const names = ["feature/News", "feature/news", "feature-news", "Feature/News"].map((branch) =>
    previewName(branch),
  );
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(name.startsWith("b-featur-")).toBe(true);
});

test("a name fits a hostname label beside a Worker name of up to 41 characters", () => {
  const name = previewName("a".repeat(400));
  expect(name.length).toBeLessThanOrEqual(21);
  expect(name).toMatch(/^[a-z0-9-]+$/);
  expect(previewName("a".repeat(400), { worker: "w".repeat(41) })).toBe(name);
  expect(`${name}-${"w".repeat(41)}`.length).toBe(MAX_LABEL_LENGTH);
  expect(() => previewName("a".repeat(400), { worker: "w".repeat(42) })).toThrow(
    "can have at most 41",
  );
});

test("the production branch and an empty branch get no name", () => {
  expect(() => previewName("main")).toThrow("production branch");
  expect(() => previewName("trunk", { productionBranch: "trunk" })).toThrow("production branch");
  expect(previewName("main", { productionBranch: "trunk" })).toMatch(/^b-main-/);
  expect(() => previewName("")).toThrow("branch name");
});

test("isPreviewName recognises the names previewName makes, and only those", () => {
  for (const branch of ["feature/News", "x", "ünïcode", "a".repeat(300)])
    expect(isPreviewName(previewName(branch))).toBe(true);
  for (const name of [
    "feature/news",
    "pr-12",
    "b-feature-dbec97bc6ac2",
    "b-featur-dbec97bc6ac",
    "main",
  ])
    expect(isPreviewName(name)).toBe(false);
});
