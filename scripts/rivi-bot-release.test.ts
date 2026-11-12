import { describe, expect, it } from "vitest";

import {
  bumpFor,
  bumpForAll,
  latestTag,
  nextVersion,
  parseTag,
  releaseNotes,
  tagFor,
} from "./rivi-bot-release.ts";

const SHA = "5267ecd0a1b2c3d4e5f60718293a4b5c6d7e8f90";

const commit = (subject: string, sha = SHA) => ({ sha, subject });

describe(parseTag, () => {
  it("reads the version a rivi-bot tag names", () => {
    expect(parseTag("rivi-bot-v1.0.0")).toStrictEqual([1, 0, 0]);
    expect(parseTag("rivi-bot-v12.3.40")).toStrictEqual([12, 3, 40]);
  });

  it("takes no other tag", () => {
    expect(parseTag("@rivi-software/deploy-watch@0.7.1")).toBeUndefined();
    expect(parseTag("rivi-bot-v1.0")).toBeUndefined();
    expect(parseTag("rivi-bot-v1.0.0-rc.1")).toBeUndefined();
    expect(parseTag("rivi-bot-v01.0.0")).toBeUndefined();
    expect(parseTag("")).toBeUndefined();
  });

  it("writes the tag back", () => {
    expect(tagFor([2, 0, 1])).toBe("rivi-bot-v2.0.1");
  });
});

describe(latestTag, () => {
  it("picks the highest version, not the last in the list", () => {
    expect(
      latestTag([
        "rivi-bot-v1.10.0",
        "rivi-bot-v1.9.3",
        "@rivi-software/deploy-watch@9.0.0",
        "rivi-bot-v1.2.0",
      ])
    ).toBe("rivi-bot-v1.10.0");
  });

  it("finds none without a rivi-bot tag", () => {
    expect(
      latestTag(["@rivi-software/deploy-watch@0.7.1", ""])
    ).toBeUndefined();
  });
});

describe(bumpFor, () => {
  it("raises the major part for a breaking change", () => {
    expect(
      bumpFor("feat(rivi-bot)!: review pull requests on Workers AI (#141)")
    ).toBe("major");
    expect(bumpFor("fix!: rename the approve input")).toBe("major");
  });

  it("raises the minor part for a feat", () => {
    expect(
      bumpFor(
        "feat(rivi-bot): fail the review check when something has to change (#143)"
      )
    ).toBe("minor");
  });

  it("raises the patch part for anything else", () => {
    expect(
      bumpFor(
        "fix(rivi-bot): post a review when the model runs out of rounds (#145)"
      )
    ).toBe("patch");
    expect(
      bumpFor("docs(rivi-bot): say how a rivi-bot release is cut (#128)")
    ).toBe("patch");
    expect(bumpFor("Merge commit from fork")).toBe("patch");
  });
});

describe(bumpForAll, () => {
  it("takes the highest part any commit raises", () => {
    expect(
      bumpForAll([commit("fix: a"), commit("feat: b"), commit("docs: c")])
    ).toBe("minor");
    expect(bumpForAll([commit("feat: a"), commit("fix(rivi-bot)!: b")])).toBe(
      "major"
    );
    expect(bumpForAll([commit("docs: a")])).toBe("patch");
  });
});

describe(nextVersion, () => {
  it("raises one part and resets the ones after it", () => {
    expect(nextVersion([1, 2, 3], "major")).toStrictEqual([2, 0, 0]);
    expect(nextVersion([1, 2, 3], "minor")).toStrictEqual([1, 3, 0]);
    expect(nextVersion([1, 2, 3], "patch")).toStrictEqual([1, 2, 4]);
  });
});

describe(releaseNotes, () => {
  it("says how to pin the release, then lists the changes oldest first", () => {
    const notes = releaseNotes({
      tag: "rivi-bot-v1.1.0",
      sha: SHA,
      commits: [
        commit(
          "fix(rivi-bot): post a review when the model runs out of rounds (#145)"
        ),
        commit(
          "feat(rivi-bot): fail the review check when something has to change (#143)"
        ),
      ],
    });

    expect(notes).toBe(
      [
        `Pin an action to this tag, such as \`rivi-software/tools/rivi-bot@rivi-bot-v1.1.0\` or \`rivi-software/tools/rivi-bot/triage@rivi-bot-v1.1.0\`, or to its commit, \`${SHA}\`.`,
        "",
        "### Changes",
        "",
        "- Fail the review check when something has to change (#143).",
        "- Post a review when the model runs out of rounds (#145).",
        "",
      ].join("\n")
    );
  });

  it("puts a breaking change under Upgrading", () => {
    const notes = releaseNotes({
      tag: "rivi-bot-v2.0.0",
      sha: SHA,
      commits: [
        commit(
          "fix(rivi-bot): post a review when the model runs out of rounds (#145)"
        ),
        commit("feat(rivi-bot)!: review pull requests on Workers AI (#141)"),
      ],
    });

    expect(notes).toContain(
      "### Changes\n\n- Post a review when the model runs out of rounds (#145).\n\n### Upgrading\n\n- Review pull requests on Workers AI (#141).\n"
    );
  });

  it("leaves out Changes when every change is breaking", () => {
    const notes = releaseNotes({
      tag: "rivi-bot-v2.0.0",
      sha: SHA,
      commits: [
        commit("feat(rivi-bot)!: review pull requests on Workers AI (#141)"),
      ],
    });

    expect(notes).not.toContain("### Changes");
    expect(notes).toContain("### Upgrading");
  });

  it("names a commit without a pull request by its short SHA", () => {
    const notes = releaseNotes({
      tag: "rivi-bot-v1.0.1",
      sha: SHA,
      commits: [
        commit(
          "Merge commit from fork",
          "1771f21a32f8f734d00c069f2fef1839a75c175f"
        ),
      ],
    });

    expect(notes).toContain("- Merge commit from fork (1771f21).");
  });
});
