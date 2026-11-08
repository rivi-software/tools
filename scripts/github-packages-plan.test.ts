import { describe, expect, it } from "vitest";

import { fromThisRepository, planCopies } from "./github-packages-plan.ts";
import type { Packument } from "./github-packages-plan.ts";

const repository = {
  type: "git",
  url: "git+https://github.com/rivi-software/tools.git",
  directory: "packages/x",
};

/** A packument with the versions in the order npm published them. */
const packument = (
  versions: string[],
  distTags: Record<string, string>
): Packument => ({
  "dist-tags": distTags,
  versions: Object.fromEntries(
    versions.map((version) => [
      version,
      version === "0.0.0-stage" ? {} : { repository },
    ])
  ),
  time: Object.fromEntries(
    versions.map((version, i) => [
      version,
      new Date(Date.UTC(2026, 9, 30, i)).toISOString(),
    ])
  ),
});

describe(fromThisRepository, () => {
  it("takes the repository as a release writes it, or in short", () => {
    expect(fromThisRepository({ repository })).toBeTruthy();
    expect(
      fromThisRepository({
        repository: "https://github.com/rivi-software/tools",
      })
    ).toBeTruthy();
  });

  it("rejects no repository, and another one", () => {
    expect(fromThisRepository({})).toBeFalsy();
    expect(
      fromThisRepository({
        repository: "git+https://github.com/someone/tools.git",
      })
    ).toBeFalsy();
  });
});

describe(planCopies, () => {
  it("copies every release oldest first, without npm's staged-publishing placeholder", () => {
    const npm = packument(["0.0.0-stage", "0.1.0", "0.1.1", "0.2.0", "0.2.1"], {
      latest: "0.2.1",
    });

    expect(planCopies(npm, new Set())).toStrictEqual({
      copies: [
        { version: "0.1.0", tag: "latest" },
        { version: "0.1.1", tag: "latest" },
        { version: "0.2.0", tag: "latest" },
        { version: "0.2.1", tag: "latest" },
      ],
      leftOut: [],
    });
  });

  it("copies only what GitHub Packages lacks", () => {
    const npm = packument(["0.1.0", "0.1.1", "0.2.0"], { latest: "0.2.0" });
    expect(planCopies(npm, new Set(["0.1.0", "0.1.1"])).copies).toStrictEqual([
      { version: "0.2.0", tag: "latest" },
    ]);
    expect(
      planCopies(npm, new Set(["0.1.0", "0.1.1", "0.2.0"])).copies
    ).toStrictEqual([]);
  });

  it("orders by when npm published them, not by version", () => {
    const npm = packument(["0.2.0", "0.1.5", "0.3.0"], { latest: "0.3.0" });
    expect(
      planCopies(npm, new Set()).copies.map(({ version }) => version)
    ).toStrictEqual(["0.2.0", "0.1.5", "0.3.0"]);
  });

  it("gives a prerelease its own tag, and a release under it latest", () => {
    const npm = packument(["1.0.0-next.0", "1.0.0-next.1", "1.0.0"], {
      latest: "1.0.0",
      next: "1.0.0-next.1",
    });

    expect(planCopies(npm, new Set()).copies).toStrictEqual([
      { version: "1.0.0-next.0", tag: "next" },
      { version: "1.0.0-next.1", tag: "next" },
      { version: "1.0.0", tag: "latest" },
    ]);
  });

  it("publishes a version two tags point at with latest", () => {
    const npm = packument(["1.0.0"], { next: "1.0.0", latest: "1.0.0" });
    expect(planCopies(npm, new Set()).copies).toStrictEqual([
      { version: "1.0.0", tag: "latest" },
    ]);
  });

  it("leaves out a version whose tag would stay on it, rather than move latest back", () => {
    // 0.1.0 has no tag on npm, and 0.2.0, which holds latest there, is on GitHub Packages already.
    const npm = packument(["0.1.0", "0.2.0"], { latest: "0.2.0" });
    expect(planCopies(npm, new Set(["0.2.0"]))).toStrictEqual({
      copies: [],
      leftOut: ["0.1.0"],
    });
  });

  it("borrows latest for a prerelease when no other tag comes later", () => {
    const npm = packument(["1.0.0-rc.0", "1.0.0"], { latest: "1.0.0" });
    expect(planCopies(npm, new Set()).copies).toStrictEqual([
      { version: "1.0.0-rc.0", tag: "latest" },
      { version: "1.0.0", tag: "latest" },
    ]);
  });
});
