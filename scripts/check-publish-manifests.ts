/**
 * Fails when a publishable package in packages/ breaks a rule CONTRIBUTING.md sets for it: its
 * package.json, the LICENSE and README it ships, its row in the root README's table of packages,
 * or its scope:<name> entry in .github/labeler.yml. scripts/package-rules.ts holds the rules.
 * Private packages are skipped.
 *   node scripts/check-publish-manifests.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { packageProblems } from "./package-rules.ts";
import type { Manifest, RepositoryFiles } from "./package-rules.ts";

const root = path.join(import.meta.dirname, "..");
const packagesDir = path.join(root, "packages");

/** A file's text, or undefined when there is no such file. */
const readIfExists = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, "utf-8") : undefined;

const repository: RepositoryFiles = {
  license: readFileSync(path.join(root, "LICENSE"), "utf-8"),
  readme: readFileSync(path.join(root, "README.md"), "utf-8"),
  labeler: readFileSync(path.join(root, ".github", "labeler.yml"), "utf-8"),
};

const problems: string[] = [];
let checked = 0;

for (const dir of existsSync(packagesDir)
  ? readdirSync(packagesDir).toSorted()
  : []) {
  const packageDir = path.join(packagesDir, dir);
  const file = path.join(packageDir, "package.json");

  if (!existsSync(file)) {
    continue;
  }

  // SAFETY: a package.json is a JSON object; every field packageProblems reads is optional.
  const manifest = JSON.parse(readFileSync(file, "utf-8")) as Manifest;

  if (manifest.private === true) {
    continue;
  }

  checked += 1;

  const found = packageProblems(
    dir,
    {
      manifest,
      license: readIfExists(path.join(packageDir, "LICENSE")),
      readme: readIfExists(path.join(packageDir, "README.md")),
    },
    repository
  );

  problems.push(...found.map((problem) => `packages/${dir}: ${problem}`));
}

if (problems.length) {
  console.error(
    "These packages break the rules in CONTRIBUTING.md#adding-a-package:"
  );

  for (const problem of problems) {
    console.error(`  ${problem}`);
  }

  process.exit(1);
}

console.log(
  `${checked} publishable package${checked === 1 ? "" : "s"} follow the rules for packages.`
);
