import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  WAIVER_LABEL,
  changesetReleases,
  checkChangesets,
  describeRelease,
  isChangeset,
  packageDirectories,
  parseNameStatus,
  passes,
  releasesOf,
  report,
} from "./changeset-rules.ts";
import type {
  ChangedFile,
  Manifest,
  PullRequest,
  Verdict,
} from "./changeset-rules.ts";

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  name: "@rivi-software/x",
  dependencies: { ignore: "^5.3.2" },
  peerDependencies: { vite: "^8.0.0" },
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  },
  ...overrides,
});

const modified = (...paths: string[]): ChangedFile[] =>
  paths.map((file) => ({ path: file, status: "modified" }));

const changeset = (...lines: string[]) =>
  ["---", ...lines, "---", "", "Fixes the thing."].join("\n");

/** A pull request that changes packages/x, with its package.json unchanged unless `head` says. */
const pullRequest = ({
  files,
  head = manifest(),
  changesets = {},
  labels = [],
}: {
  files: ChangedFile[];
  head?: Manifest;
  changesets?: Record<string, string>;
  labels?: string[];
}): PullRequest => ({
  files,
  manifests: { x: { base: manifest(), head } },
  changesets,
  labels,
});

describe(parseNameStatus, () => {
  it("reads each file's status and path, a path with spaces or a tab included", () => {
    expect(
      parseNameStatus(
        "M\0packages/x/src/a.ts\0A\0.changeset/b c.md\0D\0packages/x/src/old\tname.ts\0T\0link\0"
      )
    ).toStrictEqual([
      { path: "packages/x/src/a.ts", status: "modified" },
      { path: ".changeset/b c.md", status: "added" },
      { path: "packages/x/src/old\tname.ts", status: "deleted" },
      { path: "link", status: "modified" },
    ]);
  });

  it("reads no files from an empty diff", () => {
    expect(parseNameStatus("")).toStrictEqual([]);
  });
});

describe(packageDirectories, () => {
  it("lists each package directory once, and nothing outside packages/", () => {
    expect(
      packageDirectories(
        modified(
          "packages/x/src/a.ts",
          "packages/x/README.md",
          "packages/y/package.json",
          "scripts/packages/z.ts",
          "packages/README.md"
        )
      )
    ).toStrictEqual(["x", "y"]);
  });
});

describe(releasesOf, () => {
  it("releases a change to src/", () => {
    expect(
      releasesOf(
        modified("packages/x/src/a.ts", "packages/x/src/b/c.ts"),
        pullRequest({ files: [] }).manifests
      )
    ).toStrictEqual([
      {
        name: "@rivi-software/x",
        sources: ["packages/x/src/a.ts", "packages/x/src/b/c.ts"],
        fields: [],
      },
    ]);
  });

  it("releases nothing for tests, a README, a changelog or devDependencies", () => {
    const head = { ...manifest(), devDependencies: { vitest: "5.1.0" } };
    const { manifests } = pullRequest({ files: [], head });

    expect(
      releasesOf(
        modified(
          "packages/x/tests/a.test.ts",
          "packages/x/README.md",
          "packages/x/CHANGELOG.md",
          "packages/x/package.json",
          "packages/x/srcs/a.ts"
        ),
        manifests
      )
    ).toStrictEqual([]);
  });

  it("releases a change to dependencies, peerDependencies or exports", () => {
    const head = manifest({
      dependencies: { ignore: "^6.0.0" },
      peerDependencies: { vite: "^8.0.0", react: "^19.0.0" },
      exports: { ".": { default: "./dist/index.js" } },
    });

    expect(
      releasesOf(
        modified("packages/x/package.json"),
        pullRequest({ files: [], head }).manifests
      )
    ).toStrictEqual([
      {
        name: "@rivi-software/x",
        sources: [],
        fields: ["dependencies", "peerDependencies", "exports"],
      },
    ]);
  });

  it("reads a new order of an export's conditions as a change", () => {
    const head = manifest({
      exports: {
        ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
      },
    });

    expect(
      releasesOf(
        modified("packages/x/package.json"),
        pullRequest({ files: [], head }).manifests
      )
    ).toStrictEqual([
      { name: "@rivi-software/x", sources: [], fields: ["exports"] },
    ]);
  });

  it("releases nothing for a new package, a removed one or a private one", () => {
    const files = modified("packages/x/src/a.ts");

    expect(releasesOf(files, { x: { head: manifest() } })).toStrictEqual([]);
    expect(releasesOf(files, { x: { base: manifest() } })).toStrictEqual([]);
    expect(
      releasesOf(files, {
        x: { base: manifest(), head: manifest({ private: true }) },
      })
    ).toStrictEqual([]);
  });
});

describe(isChangeset, () => {
  it("takes a Markdown file in .changeset/, but not its README or config", () => {
    expect(isChangeset(".changeset/brave-owls-sing.md")).toBeTruthy();
    expect(isChangeset(".changeset/README.md")).toBeFalsy();
    expect(isChangeset(".changeset/config.json")).toBeFalsy();
    expect(isChangeset(".changeset/nested/a.md")).toBeFalsy();
    expect(isChangeset("packages/x/.changeset/a.md")).toBeFalsy();
  });
});

describe(changesetReleases, () => {
  it("reads each package its front matter releases, quoted either way", () => {
    expect(
      changesetReleases(
        changeset(
          '"@rivi-software/x": patch',
          "'@rivi-software/y': minor",
          '"@rivi-software/z":major'
        )
      )
    ).toStrictEqual([
      "@rivi-software/x",
      "@rivi-software/y",
      "@rivi-software/z",
    ]);
  });

  it("reads Windows line endings", () => {
    expect(
      changesetReleases(
        changeset('"@rivi-software/x": patch').replaceAll("\n", "\r\n")
      )
    ).toStrictEqual(["@rivi-software/x"]);
  });

  it("releases nothing for the bump none, an empty changeset or a name in the text", () => {
    expect(
      changesetReleases(changeset('"@rivi-software/x": none'))
    ).toStrictEqual([]);
    expect(changesetReleases(changeset())).toStrictEqual([]);
    expect(
      changesetReleases('Fixes "@rivi-software/x": patch in the text.')
    ).toStrictEqual([]);
    expect(
      changesetReleases('---\n"@rivi-software/x": patch\nno end')
    ).toStrictEqual([]);
  });
});

describe(checkChangesets, () => {
  it("fails a change to src/ without a changeset", () => {
    const verdict = checkChangesets(
      pullRequest({ files: modified("packages/x/src/a.ts") })
    );

    expect(verdict.missing.map(({ name }) => name)).toStrictEqual([
      "@rivi-software/x",
    ]);
    expect(passes(verdict)).toBeFalsy();
  });

  it("passes a change only to tests", () => {
    const verdict = checkChangesets(
      pullRequest({ files: modified("packages/x/tests/a.test.ts") })
    );

    expect(verdict.releases).toStrictEqual([]);
    expect(passes(verdict)).toBeTruthy();
  });

  it("passes a change to src/ with a changeset that names the package", () => {
    const verdict = checkChangesets(
      pullRequest({
        files: modified("packages/x/src/a.ts"),
        changesets: {
          ".changeset/a.md": changeset('"@rivi-software/x": patch'),
        },
      })
    );

    expect(verdict.missing).toStrictEqual([]);
    expect(passes(verdict)).toBeTruthy();
  });

  it("fails a changeset that names another package", () => {
    const verdict = checkChangesets(
      pullRequest({
        files: modified("packages/x/src/a.ts"),
        changesets: {
          ".changeset/a.md": changeset('"@rivi-software/y": patch'),
        },
      })
    );

    expect(passes(verdict)).toBeFalsy();
  });

  it(`passes a release without a changeset when the pull request has the ${WAIVER_LABEL} label`, () => {
    const verdict = checkChangesets(
      pullRequest({
        files: modified("packages/x/src/a.ts"),
        labels: ["scope:x", WAIVER_LABEL],
      })
    );

    expect(verdict.waived).toBeTruthy();
    expect(passes(verdict)).toBeTruthy();
  });
});

describe(describeRelease, () => {
  it("names one source file, counts several, and lists the fields", () => {
    expect(
      describeRelease({
        name: "@rivi-software/x",
        sources: ["packages/x/src/a.ts"],
        fields: [],
      })
    ).toBe("`packages/x/src/a.ts`");
    expect(
      describeRelease({
        name: "@rivi-software/x",
        sources: ["packages/x/src/a.ts", "packages/x/src/b.ts"],
        fields: ["dependencies", "exports"],
      })
    ).toBe(
      "2 files in its `src/` and `dependencies`, `exports` in its package.json"
    );
  });
});

describe(report, () => {
  const release = {
    name: "@rivi-software/x",
    sources: ["packages/x/src/a.ts"],
    fields: [],
  };

  const verdict = (overrides: Partial<Verdict>): Verdict => ({
    releases: [release],
    missing: [release],
    waived: false,
    ...overrides,
  });

  it("says how to add a missing changeset, and how to waive it", () => {
    const text = report(verdict({}));

    expect(text).toContain("- `@rivi-software/x`: `packages/x/src/a.ts`.");
    expect(text).toContain("`pnpm changeset`");
    expect(text).toContain(`\`${WAIVER_LABEL}\``);
  });

  it("names the label that waived it", () => {
    expect(report(verdict({ waived: true }))).toMatch(
      /^The `no-changeset` label says/u
    );
  });

  it("names the packages a changeset covers, and says when none needs one", () => {
    expect(report(verdict({ missing: [] }))).toContain("`@rivi-software/x`.");
    expect(report(verdict({ releases: [], missing: [] }))).toContain(
      "needs no changeset"
    );
  });
});

/**
 * scripts/check-changeset.ts on a repository of its own, with packages/x published and a branch
 * for each pull request: git's own output, not a test's idea of it.
 */
describe("check-changeset.ts", () => {
  const script = path.join(import.meta.dirname, "check-changeset.ts");
  let repo = "";

  // A repository's own settings only: no signing, hooks or name from whoever runs the tests.
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(tmpdir(), "no-global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      env: gitEnv,
      encoding: "utf-8",
    });

    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  };

  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };

  /** Commits the files on a new branch from main, as a pull request would. */
  const branch = (name: string, files: Record<string, string>) => {
    git("switch", "--quiet", "--create", name, "main");

    for (const [file, text] of Object.entries(files)) {
      write(file, text);
    }

    git("add", "--all");
    git("commit", "--quiet", "--message", name);
  };

  const check = (name: string, labels: string[] = []) =>
    spawnSync(process.execPath, [script, "main", name], {
      cwd: repo,
      env: {
        ...gitEnv,
        LABELS: JSON.stringify(labels),
        GITHUB_ACTIONS: "",
        GITHUB_STEP_SUMMARY: "",
      },
      encoding: "utf-8",
    });

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "check-changeset-"));
    git("init", "--quiet", "--initial-branch=main");
    write(".changeset/README.md", "# Changesets\n");
    write(
      "packages/x/package.json",
      `${JSON.stringify(manifest(), undefined, 2)}\n`
    );
    write("packages/x/src/index.ts", "export const x = 1;\n");
    write("packages/x/tests/index.test.ts", "// a test\n");
    git("add", "--all");
    git("commit", "--quiet", "--message", "packages/x");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails a pull request that changes src/ without a changeset", () => {
    branch("fix-without-changeset", {
      "packages/x/src/index.ts": "export const x = 2;\n",
    });

    const result = check("fix-without-changeset");

    expect(result.stdout).toContain(
      "- `@rivi-software/x`: `packages/x/src/index.ts`."
    );
    expect(result.status).toBe(1);
  });

  it("passes a pull request that changes only tests", () => {
    branch("tests-only", {
      "packages/x/tests/index.test.ts": "// another test\n",
    });

    const result = check("tests-only");

    expect(result.stdout).toContain("needs no changeset");
    expect(result.status).toBe(0);
  });

  it("passes a pull request that changes src/ with a changeset", () => {
    branch("fix-with-changeset", {
      "packages/x/src/index.ts": "export const x = 3;\n",
      ".changeset/brave-owls-sing.md": changeset('"@rivi-software/x": patch'),
    });

    expect(check("fix-with-changeset").status).toBe(0);
  });

  it(`passes a dependency bump without a changeset only with the ${WAIVER_LABEL} label`, () => {
    branch("bump", {
      "packages/x/package.json": `${JSON.stringify(manifest({ dependencies: { ignore: "^5.4.0" } }), undefined, 2)}\n`,
    });

    expect(check("bump").status).toBe(1);
    expect(check("bump", [WAIVER_LABEL]).status).toBe(0);
  });
});
