import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isPackageName, moduleMatcher, projectFiles } from "../src/modules.js";
import { temporaryDirectory, write } from "./helpers.js";

describe(moduleMatcher, () => {
  it("matches a package name wherever the package is installed", () => {
    const msw = moduleMatcher("msw");
    expect(
      [
        "node_modules/msw/lib/core/index.mjs",
        "node_modules/.pnpm/msw@2.7.0/node_modules/msw/lib/core/index.mjs",
        "../../node_modules/.pnpm/msw@2.7.0/node_modules/msw/lib/index.js",
        "node_modules/a/node_modules/msw/index.js",
        "node_modules/msw-extra/index.js",
        "node_modules/@mswjs/interceptors/index.js",
        "src/msw/handlers.ts",
        "msw/index.js",
      ].filter(msw)
    ).toStrictEqual([
      "node_modules/msw/lib/core/index.mjs",
      "node_modules/.pnpm/msw@2.7.0/node_modules/msw/lib/core/index.mjs",
      "../../node_modules/.pnpm/msw@2.7.0/node_modules/msw/lib/index.js",
      "node_modules/a/node_modules/msw/index.js",
    ]);
    const scoped = moduleMatcher("@faker-js/faker");
    expect(
      scoped(
        "node_modules/.pnpm/@faker-js+faker@9.0.0/node_modules/@faker-js/faker/a.js"
      )
    ).toBeTruthy();
    expect(scoped("node_modules/@faker-js/faker-extra/a.js")).toBeFalsy();
  });

  it("matches a glob against the path, through dot directories and outside cwd", () => {
    const icons = moduleMatcher("**/icons/all.js");
    expect(
      icons("node_modules/.pnpm/lib@1.0.0/node_modules/lib/dist/icons/all.js")
    ).toBeTruthy();
    expect(icons("../../node_modules/lib/icons/all.js")).toBeTruthy();
    expect(icons("icons/all.js")).toBeTruthy();
    expect(icons("node_modules/lib/icons/all.json")).toBeFalsy();
  });

  it("anchors a glob that starts with ./ to the root of the project", () => {
    const mocks = moduleMatcher("./src/mocks/**");
    expect(mocks("src/mocks/handlers.ts")).toBeTruthy();
    expect(mocks("src/mocks/deep/a.ts")).toBeTruthy();
    expect(mocks("lib/src/mocks/a.ts")).toBeFalsy();
  });

  it("tests a regular expression without keeping state", () => {
    const matches = moduleMatcher(/\/mocks?\//gu);
    expect([
      matches("src/mocks/a.ts"),
      matches("src/mocks/a.ts"),
      matches("src/a.ts"),
    ]).toStrictEqual([true, true, false]);
  });

  it("tells a package name from a glob", () => {
    expect(
      [
        "msw",
        "@faker-js/faker",
        "lodash.merge",
        "src",
        "src/mocks/**",
        "**/x.js",
        "MSW",
      ].map(isPackageName)
    ).toStrictEqual([true, true, true, true, false, false, false]);
  });
});

describe(projectFiles, () => {
  it("walks the project and its parents' node_modules, each real directory once", async () => {
    const root = temporaryDirectory();
    write(root, {
      "node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.js": "",
      "node_modules/.pnpm/lib@1.0.0/node_modules/lib/node_modules/.keep": "",
      "packages/shared/src/a.ts": "",
      "packages/other/src/b.ts": "",
      "apps/web/src/index.ts": "",
      "apps/web/dist/server/index.js": "",
      "apps/web/.git/HEAD": "",
      "apps/sibling/src/c.ts": "",
    });
    const app = path.join(root, "apps/web");
    mkdirSync(path.join(app, "node_modules/@x"), { recursive: true });
    symlinkSync(
      "../../../node_modules/.pnpm/lib@1.0.0/node_modules/lib",
      path.join(app, "node_modules/lib")
    );
    symlinkSync(
      "../../../../packages/shared",
      path.join(app, "node_modules/@x/shared")
    );
    symlinkSync("..", path.join(app, "src/loop"));
    const files: string[] = [];

    for await (const { path: file } of projectFiles(app, [
      path.join(app, "dist/server"),
    ])) {
      files.push(file);
    }

    expect(files.toSorted()).toStrictEqual([
      "../../node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.js",
      "../../node_modules/.pnpm/lib@1.0.0/node_modules/lib/node_modules/.keep",
      "../../packages/shared/src/a.ts",
      "src/index.ts",
    ]);
  });
});
