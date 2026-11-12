import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUGS_URL,
  REPOSITORY_URL,
  homepageUrl,
  labelerGlobs,
  labelerProblems,
  manifestProblems,
  packageProblems,
  packageTable,
  readmeRow,
} from "./package-rules.ts";
import type {
  Manifest,
  PackageFiles,
  RepositoryFiles,
} from "./package-rules.ts";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf-8");

/** The package.json template in CONTRIBUTING.md, filled in for packages/x. */
const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  name: "@rivi-software/x",
  version: "0.1.0",
  description: "Does one thing",
  license: "MIT",
  type: "module",
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  },
  files: ["dist"],
  sideEffects: false,
  scripts: {
    build: "rm -rf dist && tsc -p tsconfig.build.json",
    check: "tsc --noEmit",
    test: "vitest run",
  },
  repository: {
    type: "git",
    url: REPOSITORY_URL,
    directory: "packages/x",
  },
  homepage: homepageUrl("x"),
  bugs: BUGS_URL,
  publishConfig: { access: "public" },
  ...overrides,
});

const LABELER = `# The scope:* label of each path a pull request changes.
scope:x:
  - changed-files:
      - any-glob-to-any-file: packages/x/**
scope:rivi-bot:
  - changed-files:
      - any-glob-to-any-file:
          - rivi-bot/**
          - ".github/workflows/rivi-bot.yml" # the reusable workflow
scope:repo:
  - changed-files:
      - all-globs-to-any-file:
          - .github/**
          - "!.github/workflows/rivi-bot.yml"
`;

const README = `# Tools

## Packages

| Package | What it does | Runs in | Downloads |
| --- | --- | --- | --- |
| [\`x\`](packages/x#readme) ([npm](https://www.npmjs.com/package/@rivi-software/x)) | Does one thing | Workers | badge |
| [\`y\`](packages/y#readme) ([npm](https://www.npmjs.com/package/@rivi-software/y)) | Splits \\| joins | Node, CI | badge |

Each is published as \`@rivi-software/<name>\`.

| Not | The | Table |
| --- | --- | --- |
| [\`z\`](packages/z#readme) | z | Node |

## rivi-bot
`;

const LICENSE = "MIT License\n\nCopyright (c) 2026 RIVI Software\n";

const repository = (
  overrides: Partial<RepositoryFiles> = {}
): RepositoryFiles => ({
  license: LICENSE,
  readme: README,
  labeler: LABELER,
  ...overrides,
});

const files = (overrides: Partial<PackageFiles> = {}): PackageFiles => ({
  manifest: manifest(),
  license: LICENSE,
  readme: "# x\n",
  ...overrides,
});

/** What packageProblems finds in packages/workers-mail, with the repository's files as they are but for `overrides`. */
const workersMail = (overrides: Partial<RepositoryFiles>) =>
  packageProblems(
    "workers-mail",
    {
      // SAFETY: a package.json is a JSON object; every field packageProblems reads is optional.
      manifest: JSON.parse(
        read("packages/workers-mail/package.json")
      ) as Manifest,
      license: read("packages/workers-mail/LICENSE"),
      readme: read("packages/workers-mail/README.md"),
    },
    {
      license: read("LICENSE"),
      readme: read("README.md"),
      labeler: read(".github/labeler.yml"),
      ...overrides,
    }
  );

describe(manifestProblems, () => {
  it("passes the template in CONTRIBUTING.md", () => {
    expect(manifestProblems("x", manifest())).toStrictEqual([]);
  });

  it("asks for the @rivi-software scope and a semver version", () => {
    expect(
      manifestProblems("x", manifest({ name: "x", version: "1.0" }))
    ).toStrictEqual([
      `"name" must be @rivi-software/<name>, not "x"`,
      `"version" must be a semver version, not "1.0"`,
    ]);
    expect(
      manifestProblems("x", manifest({ name: "@rivi-software/" }))
    ).toStrictEqual([
      `"name" must be @rivi-software/<name>, not "@rivi-software/"`,
    ]);
  });

  it("takes a prerelease version", () => {
    expect(
      manifestProblems("x", manifest({ version: "1.0.0-next.1" }))
    ).toStrictEqual([]);
  });

  it("asks for a description, the MIT license and ESM", () => {
    expect(
      manifestProblems(
        "x",
        manifest({ description: " ", license: "ISC", type: "commonjs" })
      )
    ).toStrictEqual([
      `"description" is missing`,
      `"license" must be "MIT"`,
      `"type" must be "module"`,
    ]);
  });

  it("asks for the repository npm's provenance check compares, in the package's directory", () => {
    const expected = [
      `"repository" must be { "type": "git", "url": "${REPOSITORY_URL}", "directory": "packages/x" }; npm refuses a trusted publish whose repository differs`,
    ];

    expect(
      manifestProblems("x", manifest({ repository: REPOSITORY_URL }))
    ).toStrictEqual(expected);
    expect(
      manifestProblems(
        "x",
        manifest({
          repository: {
            type: "git",
            url: "https://github.com/rivi-software/tools",
            directory: "packages/x",
          },
        })
      )
    ).toStrictEqual(expected);
    expect(manifestProblems("y", manifest())).toContain(
      `"repository" must be { "type": "git", "url": "${REPOSITORY_URL}", "directory": "packages/y" }; npm refuses a trusted publish whose repository differs`
    );
  });

  it("asks for the homepage and bugs that CONTRIBUTING.md lists", () => {
    expect(
      manifestProblems("x", manifest({ homepage: undefined, bugs: undefined }))
    ).toStrictEqual([
      `"homepage" must be "https://github.com/rivi-software/tools/tree/main/packages/x#readme"`,
      `"bugs" must be "https://github.com/rivi-software/tools/issues"`,
    ]);
    expect(
      manifestProblems("x", manifest({ homepage: homepageUrl("y") }))
    ).toStrictEqual([`"homepage" must be "${homepageUrl("x")}"`]);
  });

  it("asks for dist in files and public access", () => {
    expect(
      manifestProblems(
        "x",
        manifest({ files: ["src"], publishConfig: undefined })
      )
    ).toStrictEqual([
      `"files" must include "dist"`,
      `"publishConfig.access" must be "public"`,
    ]);
  });

  it("asks for sideEffects, false or the files that have them", () => {
    const problem = `"sideEffects" must be false, or list the files that have side effects`;

    expect(
      manifestProblems("x", manifest({ sideEffects: undefined }))
    ).toStrictEqual([problem]);
    expect(
      manifestProblems("x", manifest({ sideEffects: true }))
    ).toStrictEqual([problem]);
    expect(
      manifestProblems("x", manifest({ sideEffects: ["./dist/register.js"] }))
    ).toStrictEqual([]);
  });

  it("asks for each script the root runs in every package", () => {
    expect(
      manifestProblems("x", manifest({ scripts: { build: "tsc" } }))
    ).toStrictEqual([
      `"scripts.check" is missing; \`pnpm -r run check\` skips a package without it`,
      `"scripts.test" is missing; \`pnpm -r run test\` skips a package without it`,
    ]);
  });

  it("asks for engines.node where the package runs in Node", () => {
    const problem = `"engines.node" is missing; a package that runs in Node names the versions it supports, such as ">=22"`;

    expect(
      manifestProblems("x", manifest(), { runsInNode: true })
    ).toStrictEqual([problem]);
    expect(
      manifestProblems("x", manifest({ engines: { node: ">=22" } }), {
        runsInNode: true,
      })
    ).toStrictEqual([]);
  });

  it("takes a bin to run in Node", () => {
    expect(
      manifestProblems("x", manifest({ bin: { x: "./dist/cli.js" } }))
    ).toStrictEqual([
      `"engines.node" is missing; a package that runs in Node names the versions it supports, such as ">=22"`,
    ]);
  });

  it("asks for a bin that is a .js file in dist/, by its command", () => {
    const engines = { node: ">=22" };

    expect(
      manifestProblems(
        "x",
        manifest({ bin: { x: "./src/cli.ts", y: "./dist/cli.js" }, engines })
      )
    ).toStrictEqual([
      `"bin" "x" names ./src/cli.ts, which is not a .js file in ./dist/`,
    ]);
    expect(
      manifestProblems("x", manifest({ bin: "./cli.js", engines }))
    ).toStrictEqual([
      `"bin" "@rivi-software/x" names ./cli.js, which is not a .js file in ./dist/`,
    ]);
  });

  it("asks for exports as an object of entry points", () => {
    expect(
      manifestProblems("x", manifest({ exports: "./dist/index.js" }))
    ).toStrictEqual([`"exports" must be an object`]);
    expect(
      manifestProblems("x", manifest({ exports: undefined }))
    ).toStrictEqual([`"exports" must be an object`]);
  });

  it("asks for each entry point's types first, with a default", () => {
    expect(
      manifestProblems(
        "x",
        manifest({
          exports: {
            ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
            "./vite": { types: "./dist/vite.d.ts", import: "./dist/vite.js" },
            "./cli": "./dist/cli.js",
          },
        })
      )
    ).toStrictEqual([
      `"exports" "." must list "types" first and include "default"`,
      `"exports" "./vite" must list "types" first and include "default"`,
      `"exports" "./cli" must be { "types": …, "default": … }`,
    ]);
  });

  it("asks for every exported file to be in dist/, nested conditions included", () => {
    expect(
      manifestProblems(
        "x",
        manifest({
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              worker: {
                types: "./dist/worker.d.ts",
                default: "./src/worker.ts",
              },
              default: "./index.js",
            },
          },
        })
      )
    ).toStrictEqual([
      `"exports" ". worker default" names ./src/worker.ts, which is not in ./dist/`,
      `"exports" ". default" names ./index.js, which is not in ./dist/`,
    ]);
  });
});

describe(labelerGlobs, () => {
  it("reads each label's globs, on one line or as a list", () => {
    expect(labelerGlobs(LABELER)).toStrictEqual(
      new Map([
        ["scope:x", ["packages/x/**"]],
        ["scope:rivi-bot", ["rivi-bot/**", ".github/workflows/rivi-bot.yml"]],
        ["scope:repo", [".github/**", "!.github/workflows/rivi-bot.yml"]],
      ])
    );
  });

  it("reads a quoted label", () => {
    expect(
      labelerGlobs(
        `"scope:x":\n  - changed-files:\n      - any-glob-to-any-file: 'packages/x/**'\n`
      )
    ).toStrictEqual(new Map([["scope:x", ["packages/x/**"]]]));
  });

  it("reads the repository's own labeler.yml", () => {
    const globs = labelerGlobs(read(".github/labeler.yml"));

    expect(globs.get("scope:workers-mail")).toStrictEqual([
      "packages/workers-mail/**",
    ]);
    expect(globs.get("scope:rivi-bot")).toContain("rivi-bot/**");
  });
});

describe(labelerProblems, () => {
  it("passes a package its scope maps", () => {
    expect(labelerProblems("x", LABELER)).toStrictEqual([]);
  });

  it("fails a package with no scope", () => {
    expect(labelerProblems("y", LABELER)).toStrictEqual([
      ".github/labeler.yml must map scope:y to packages/y/**, or the package's pull requests get no scope label",
    ]);
  });

  it("fails a scope that maps another directory", () => {
    expect(
      labelerProblems(
        "y",
        "scope:y:\n  - changed-files:\n      - any-glob-to-any-file: packages/x/**\n"
      )
    ).toHaveLength(1);
  });

  it("fails a package whose directory only another scope maps", () => {
    expect(
      labelerProblems(
        "y",
        "scope:repo:\n  - changed-files:\n      - any-glob-to-any-file: packages/y/**\n"
      )
    ).toHaveLength(1);
  });
});

describe(packageTable, () => {
  it("reads the rows under the Packages heading by column, and no other table", () => {
    const rows = packageTable(README);

    expect(rows.map((row) => row["Runs in"])).toStrictEqual([
      "Workers",
      "Node, CI",
    ]);
    expect(rows[1]["What it does"]).toBe("Splits \\| joins");
  });

  it("reads no rows from a README without the heading", () => {
    expect(
      packageTable("# Tools\n\n| Package |\n| --- |\n| x |\n")
    ).toStrictEqual([]);
  });
});

describe(readmeRow, () => {
  it("finds a package by its name and link", () => {
    expect(readmeRow("x", README)?.Package).toMatch(
      /^\[`x`\]\(packages\/x#readme\)/u
    );
  });

  it("finds no row for a package that is not in the table", () => {
    expect(readmeRow("z", README)).toBeUndefined();
    expect(readmeRow("w", README)).toBeUndefined();
  });

  it("finds no row for a name that only starts the same", () => {
    expect(
      readmeRow("x", README.replaceAll("packages/x#", "packages/x-y#"))
    ).toBeUndefined();
  });
});

describe(packageProblems, () => {
  it("passes a package that follows every rule", () => {
    expect(packageProblems("x", files(), repository())).toStrictEqual([]);
  });

  it("asks for a copy of the root LICENSE and a README", () => {
    expect(
      packageProblems(
        "x",
        files({ license: "ISC License\n", readme: undefined }),
        repository()
      )
    ).toStrictEqual([
      "LICENSE must be a copy of the root LICENSE; npm ships only the package's own",
      "README.md is missing",
    ]);
    expect(
      packageProblems("x", files({ license: undefined }), repository())
    ).toHaveLength(1);
  });

  it("asks for a row in the root README and a scope in labeler.yml", () => {
    expect(
      packageProblems(
        "w",
        files({
          manifest: manifest({
            name: "@rivi-software/w",
            repository: {
              type: "git",
              url: REPOSITORY_URL,
              directory: "packages/w",
            },
            homepage: homepageUrl("w"),
          }),
        }),
        repository()
      )
    ).toStrictEqual([
      "the root README's table of packages has no row for it; add one that starts [`w`](packages/w#readme)",
      ".github/labeler.yml must map scope:w to packages/w/**, or the package's pull requests get no scope label",
    ]);
  });

  it("asks for engines.node when the README says the package runs in Node", () => {
    const y = manifest({
      name: "@rivi-software/y",
      repository: { type: "git", url: REPOSITORY_URL, directory: "packages/y" },
      homepage: homepageUrl("y"),
    });

    const labeler = `${LABELER}scope:y:\n  - changed-files:\n      - any-glob-to-any-file: packages/y/**\n`;

    expect(
      packageProblems("y", files({ manifest: y }), repository({ labeler }))
    ).toStrictEqual([
      `"engines.node" is missing; a package that runs in Node names the versions it supports, such as ">=22"`,
    ]);
    expect(
      packageProblems(
        "y",
        files({ manifest: { ...y, engines: { node: ">=22" } } }),
        repository({ labeler })
      )
    ).toStrictEqual([]);
  });

  it("passes a package of the repository as it is", () => {
    expect(workersMail({})).toStrictEqual([]);
  });

  it("fails a package whose line is gone from labeler.yml", () => {
    const labeler = read(".github/labeler.yml").replace(
      "scope:workers-mail:\n  - changed-files:\n      - any-glob-to-any-file: packages/workers-mail/**\n",
      ""
    );

    expect(labeler).not.toContain("scope:workers-mail");
    expect(workersMail({ labeler })).toStrictEqual([
      ".github/labeler.yml must map scope:workers-mail to packages/workers-mail/**, or the package's pull requests get no scope label",
    ]);
  });

  it("fails a package whose row is gone from the README", () => {
    const readme = read("README.md")
      .split("\n")
      .filter((line) => !line.startsWith("| [`workers-mail`]"))
      .join("\n");

    expect(readme).not.toContain("packages/workers-mail#readme");
    expect(workersMail({ readme })).toStrictEqual([
      "the root README's table of packages has no row for it; add one that starts [`workers-mail`](packages/workers-mail#readme)",
    ]);
  });
});
