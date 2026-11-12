import { describe, expect, it } from "vitest";

import {
  bumpFor,
  bumpForAll,
  latestTag,
  MAIN,
  nextVersion,
  parseTag,
  planRelease,
  releaseNotes,
  tagFor,
} from "./rivi-bot-release.ts";
import type { CiRun, Draft, ReleaseSource } from "./rivi-bot-release.ts";

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
        `Pin to this tag, such as \`rivi-software/tools/rivi-bot@rivi-bot-v1.1.0\` or \`rivi-software/tools/rivi-bot/triage@rivi-bot-v1.1.0\` for an action and \`rivi-software/tools/.github/workflows/rivi-bot.yml@rivi-bot-v1.1.0\` for the reusable workflow, or to its commit, \`${SHA}\`.`,
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

/** A commit's SHA by its place on main, from 1: `1111…`, `2222…`, so each short SHA is its own. */
const sha = (place: number) => place.toString(16).repeat(40);

/** A commit that exists in the clone but is not on main. */
const OFF_MAIN = "f".repeat(40);

const PASSED: CiRun = {
  url: "https://github.com/rivi-software/tools/actions/runs/1",
  status: "completed",
  conclusion: "success",
};

/** Main's commits, oldest first. The first is rivi-bot-v1.0.0's unless a test tags others. */
const HISTORY = [
  { subject: "fix(rivi-bot): what the last release fixed (#1)" },
  {
    subject:
      "fix(rivi-bot): post a review when the model runs out of rounds (#2)",
  },
  { subject: "feat(workers-mail): send a raw message (#3)", rivibot: false },
  { subject: "feat(rivi-bot): fail the review check (#4)" },
];

/**
 * A clone and a GitHub with a straight main: `history` oldest first, each commit changing
 * rivi-bot unless `rivibot` is false, and `tags` at their place in it, from 1. `asked` records
 * each question to GitHub.
 */
const fakeSource = ({
  history = HISTORY,
  tags = { "rivi-bot-v1.0.0": 1 },
  ciRuns = [PASSED],
  drafts = [],
}: {
  history?: { subject: string; rivibot?: boolean }[];
  tags?: Record<string, number>;
  ciRuns?: CiRun[];
  drafts?: Draft[];
} = {}) => {
  const asked: string[] = [];
  const shas = history.map((_, index) => sha(index + 1));

  /** A ref's place on main, from 1, or 0 when it is not on main. */
  const place = (ref: string): number => {
    if (ref === MAIN) {
      return shas.length;
    }

    return tags[ref] ?? shas.indexOf(ref) + 1;
  };

  const source: ReleaseSource = {
    resolve: (name) =>
      name === MAIN
        ? shas.at(-1)
        : [...shas, OFF_MAIN].find((full) => full.startsWith(name)),
    isAncestor: (ancestor, descendant) =>
      place(ancestor) > 0 &&
      place(descendant) > 0 &&
      place(ancestor) <= place(descendant),
    tags: () => Object.keys(tags),
    commits: (from, to) =>
      history
        .map(({ subject, rivibot }, index) => ({
          sha: shas[index],
          subject,
          rivibot,
          at: index + 1,
        }))
        .filter(
          ({ at, rivibot }) =>
            at > place(from) && at <= place(to) && rivibot !== false
        )
        .map(({ sha: full, subject }) => ({ sha: full, subject }))
        .toReversed(),
    ciRun: () => {
      asked.push("ci");

      return Promise.resolve(ciRuns.at(0));
    },
    waitingDraft: () => {
      asked.push("draft");

      return Promise.resolve(drafts.at(0));
    },
  };

  return { source, asked };
};

const AUTO = { bump: "auto", commit: "", ref: "refs/heads/main" };

describe(planRelease, () => {
  it("drafts the next version on the head of main, from the rivi-bot commits since the last tag", async () => {
    const { source, asked } = fakeSource();
    const plan = await planRelease(AUTO, source);

    expect(plan).toMatchObject({
      tag: "rivi-bot-v1.1.0",
      sha: sha(4),
      last: "rivi-bot-v1.0.0",
      bump: "minor",
      requested: "auto",
      warnings: [],
      ci: PASSED.url,
    });
    expect(plan.commits.map(({ subject }) => subject)).toStrictEqual([
      "feat(rivi-bot): fail the review check (#4)",
      "fix(rivi-bot): post a review when the model runs out of rounds (#2)",
    ]);
    expect(plan.notes).toContain(
      "- Post a review when the model runs out of rounds (#2).\n- Fail the review check (#4).\n"
    );
    expect(plan.notes).not.toContain("raw message");
    expect(asked).toStrictEqual(["ci", "draft"]);
  });

  it("follows the highest rivi-bot tag", async () => {
    const { source } = fakeSource({
      tags: { "rivi-bot-v1.0.0": 1, "rivi-bot-v1.2.0": 2 },
    });

    await expect(planRelease(AUTO, source)).resolves.toMatchObject({
      tag: "rivi-bot-v1.3.0",
      last: "rivi-bot-v1.2.0",
      commits: [{ subject: "feat(rivi-bot): fail the review check (#4)" }],
    });
  });

  it("raises the major part after a breaking change", async () => {
    const { source } = fakeSource({
      history: [
        ...HISTORY,
        { subject: "feat(rivi-bot)!: review on Workers AI (#5)" },
      ],
    });

    await expect(planRelease(AUTO, source)).resolves.toMatchObject({
      tag: "rivi-bot-v2.0.0",
      bump: "major",
    });
  });

  it("takes the part the run asks for, and warns only when the titles call for a higher one", async () => {
    const lower = await planRelease(
      { ...AUTO, bump: "patch" },
      fakeSource().source
    );

    expect(lower).toMatchObject({ tag: "rivi-bot-v1.0.1", requested: "patch" });
    expect(lower.warnings).toStrictEqual([
      "The commit titles call for a minor release, and the run asked for patch. Check that no change needs a caller to act.",
    ]);

    await expect(
      planRelease({ ...AUTO, bump: "major" }, fakeSource().source)
    ).resolves.toMatchObject({ tag: "rivi-bot-v2.0.0", warnings: [] });
  });

  it("releases the commit the run names by a short SHA, with the commits up to it", async () => {
    const { source } = fakeSource();

    await expect(
      planRelease({ ...AUTO, commit: " 2222222 " }, source)
    ).resolves.toMatchObject({
      tag: "rivi-bot-v1.0.1",
      sha: sha(2),
      commits: [{ sha: sha(2) }],
    });
  });

  it("runs outside GitHub Actions, where no ref is set", async () => {
    const { source } = fakeSource();

    await expect(
      planRelease({ ...AUTO, ref: undefined }, source)
    ).resolves.toMatchObject({ tag: "rivi-bot-v1.1.0" });
  });

  it("refuses a part it does not know, and a run from another branch", async () => {
    const { source } = fakeSource();

    await expect(
      planRelease({ ...AUTO, bump: "huge" }, source)
    ).rejects.toThrow("BUMP is huge");
    await expect(
      planRelease({ ...AUTO, bump: undefined }, source)
    ).rejects.toThrow("BUMP is unset");
    await expect(
      planRelease({ ...AUTO, ref: "refs/heads/ci/x" }, source)
    ).rejects.toThrow("Run the workflow from main, not refs/heads/ci/x.");
  });

  it("refuses a commit that is not a SHA, not in the clone, or not on main", async () => {
    const { source } = fakeSource();

    await expect(
      planRelease({ ...AUTO, commit: "main~1" }, source)
    ).rejects.toThrow("COMMIT is not a commit SHA: main~1");
    await expect(
      planRelease({ ...AUTO, commit: "abcdef0" }, source)
    ).rejects.toThrow("abcdef0 is not a commit in this clone.");
    await expect(
      planRelease({ ...AUTO, commit: OFF_MAIN.slice(0, 7) }, source)
    ).rejects.toThrow(`${OFF_MAIN} is not on main.`);
  });

  it("refuses a commit before the last release, and the last release's own commit", async () => {
    const { source } = fakeSource({ tags: { "rivi-bot-v1.0.0": 2 } });

    await expect(
      planRelease({ ...AUTO, commit: sha(1) }, source)
    ).rejects.toThrow(`${sha(1)} comes before rivi-bot-v1.0.0`);
    await expect(
      planRelease({ ...AUTO, commit: sha(2) }, source)
    ).rejects.toThrow(
      `Nothing in rivi-bot or .github/workflows/rivi-bot.yml changed between rivi-bot-v1.0.0 and ${sha(2)}.`
    );
  });

  it("refuses when only something other than rivi-bot changed since the last release", async () => {
    const { source } = fakeSource({ tags: { "rivi-bot-v1.0.0": 2 } });

    await expect(
      planRelease({ ...AUTO, commit: sha(3) }, source)
    ).rejects.toThrow("Nothing in rivi-bot");
  });

  it("refuses without a rivi-bot tag to follow", async () => {
    const { source } = fakeSource({ tags: {} });

    await expect(planRelease(AUTO, source)).rejects.toThrow(
      "There is no rivi-bot-v* tag to follow."
    );
  });

  it("waits for CI to pass on the commit", async () => {
    await expect(
      planRelease(AUTO, fakeSource({ ciRuns: [] }).source)
    ).rejects.toThrow(`CI has not run on ${sha(4)} as a push to main.`);
    await expect(
      planRelease(
        AUTO,
        fakeSource({
          ciRuns: [{ ...PASSED, status: "in_progress", conclusion: null }],
        }).source
      )
    ).rejects.toThrow(`CI is still running on ${sha(4)}`);
    await expect(
      planRelease(
        AUTO,
        fakeSource({ ciRuns: [{ ...PASSED, conclusion: "cancelled" }] }).source
      )
    ).rejects.toThrow(`CI ended as cancelled on ${sha(4)}`);
  });

  it("refuses while another rivi-bot release waits as a draft", async () => {
    const { source } = fakeSource({
      drafts: [{ tag: "rivi-bot-v1.1.0", url: "https://github.com/draft" }],
    });

    await expect(planRelease(AUTO, source)).rejects.toThrow(
      "rivi-bot-v1.1.0 waits as a draft: https://github.com/draft."
    );
  });

  it("asks GitHub nothing when the clone already rules the release out", async () => {
    const { source, asked } = fakeSource({ tags: { "rivi-bot-v1.0.0": 4 } });

    await expect(planRelease(AUTO, source)).rejects.toThrow(
      "Nothing in rivi-bot"
    );
    expect(asked).toStrictEqual([]);
  });
});
