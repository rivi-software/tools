/**
 * Fails when a publishable package breaks the rules npm publishing relies on
 * (CONTRIBUTING.md#packagejson): the @rivi-software scope, the MIT license with its text in the
 * package, the repository field npm's provenance check compares with this repository, `exports`,
 * `bin` and `files` that name built files in dist/ (each entry point with its types), and public
 * access. Private packages are skipped.
 *   node scripts/check-publish-manifests.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const SCOPE = "@rivi-software/";
export const REPOSITORY_URL = "git+https://github.com/rivi-software/tools.git";

type ExportTarget = string | { [condition: string]: ExportTarget } | null;

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  description?: string;
  license?: string;
  type?: string;
  repository?: string | { type?: string; url?: string; directory?: string };
  files?: string[];
  exports?: ExportTarget;
  bin?: string | Record<string, string>;
  publishConfig?: { access?: string };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Whether an `exports` entry names a file, rather than conditions to pick one. */
const isExportFile = (target: ExportTarget): target is string =>
  typeof target === "string";

/** Whether an `exports` entry is a map: conditions, or subpaths at the top. */
const isExportMap = (
  target: ExportTarget
): target is { [condition: string]: ExportTarget } =>
  typeof target === "object" && target !== null;

/** Whether a manifest's `repository` is the long form, rather than the URL on its own. */
const isRepositoryObject = (
  repository: Manifest["repository"]
): repository is { type?: string; url?: string; directory?: string } =>
  typeof repository === "object";

/** Whether a manifest's `bin` is the short form, the one command named after the package. */
const isSingleBin = (bin: Manifest["bin"]): bin is string =>
  typeof bin === "string";

/** One file an `exports` entry names, with the subpath and condition that name it. */
interface ExportFile {
  subpath: string;
  target: string;
}

/** Every file an `exports` entry names, by its subpath and condition. */
const exportTargets = (
  exports: ExportTarget,
  subpath: string
): ExportFile[] => {
  if (isExportFile(exports)) {
    return [{ subpath, target: exports }];
  }

  if (!exports) {
    return [];
  }

  return Object.entries(exports).flatMap(([key, value]) =>
    exportTargets(value, key.startsWith(".") ? key : `${subpath} ${key}`)
  );
};

/** What is wrong with the manifest's `exports`. */
const exportsProblems = (exports: ExportTarget): string[] => {
  const problems: string[] = [];

  if (!isExportMap(exports)) {
    problems.push(`"exports" must be an object`);

    return problems;
  }

  for (const [subpath, target] of Object.entries(exports)) {
    if (!isExportMap(target) || Array.isArray(target)) {
      problems.push(
        `"exports" "${subpath}" must be { "types": …, "default": … }`
      );
      continue;
    }

    const conditions = Object.keys(target);

    if (conditions[0] !== "types" || !conditions.includes("default")) {
      problems.push(
        `"exports" "${subpath}" must list "types" first and include "default"`
      );
    }
  }

  for (const { subpath, target } of exportTargets(exports, ".")) {
    if (!target.startsWith("./dist/")) {
      problems.push(
        `"exports" "${subpath}" names ${target}, which is not in ./dist/`
      );
    }
  }

  return problems;
};

/** What is wrong with the manifest's `repository`, which npm's provenance check reads. */
const repositoryProblems = (
  dir: string,
  field: Manifest["repository"]
): string[] => {
  const repository = isRepositoryObject(field) ? field : undefined;

  if (
    repository?.type !== "git" ||
    repository.url !== REPOSITORY_URL ||
    repository.directory !== `packages/${dir}`
  ) {
    return [
      `"repository" must be { "type": "git", "url": "${REPOSITORY_URL}", "directory": "packages/${dir}" }; npm refuses a trusted publish whose repository differs`,
    ];
  }

  return [];
};

/** What is wrong with the files the manifest's `bin` names. */
const binProblems = (name: string, bin: Manifest["bin"]): string[] => {
  const problems: string[] = [];
  const bins = isSingleBin(bin) ? { [name]: bin } : (bin ?? {});

  for (const [command, target] of Object.entries(bins)) {
    if (!target.startsWith("./dist/") || !target.endsWith(".js")) {
      problems.push(
        `"bin" "${command}" names ${target}, which is not a .js file in ./dist/`
      );
    }
  }

  return problems;
};

/** What is wrong with the manifest of the package in `packages/<dir>`; empty when nothing is. */
export const manifestProblems = (dir: string, manifest: Manifest): string[] => {
  const problems: string[] = [];
  const name = manifest.name ?? "";

  if (!name.startsWith(SCOPE) || name.length === SCOPE.length) {
    problems.push(`"name" must be ${SCOPE}<name>, not "${name}"`);
  }

  if (!SEMVER.test(manifest.version ?? "")) {
    problems.push(
      `"version" must be a semver version, not "${manifest.version}"`
    );
  }

  if (!manifest.description?.trim()) {
    problems.push(`"description" is missing`);
  }

  if (manifest.license !== "MIT") {
    problems.push(`"license" must be "MIT"`);
  }

  if (manifest.type !== "module") {
    problems.push(`"type" must be "module"`);
  }

  problems.push(...repositoryProblems(dir, manifest.repository));

  if (!manifest.files?.includes("dist")) {
    problems.push(`"files" must include "dist"`);
  }

  if (manifest.publishConfig?.access !== "public") {
    problems.push(`"publishConfig.access" must be "public"`);
  }

  problems.push(
    ...exportsProblems(manifest.exports ?? null),
    ...binProblems(name, manifest.bin)
  );

  return problems;
};

const root = path.join(import.meta.dirname, "..");
const license = readFileSync(path.join(root, "LICENSE"), "utf-8");
const packagesDir = path.join(root, "packages");
const problems: string[] = [];
let checked = 0;

for (const dir of existsSync(packagesDir)
  ? readdirSync(packagesDir).toSorted()
  : []) {
  const file = path.join(packagesDir, dir, "package.json");

  if (!existsSync(file)) {
    continue;
  }

  // SAFETY: a package.json is a JSON object; every field manifestProblems reads is optional.
  const manifest = JSON.parse(readFileSync(file, "utf-8")) as Manifest;

  if (manifest.private === true) {
    continue;
  }

  checked += 1;
  const found = manifestProblems(dir, manifest);
  const packageLicense = path.join(packagesDir, dir, "LICENSE");

  if (
    !existsSync(packageLicense) ||
    readFileSync(packageLicense, "utf-8") !== license
  ) {
    found.push(
      "LICENSE must be a copy of the root LICENSE; npm ships only the package's own"
    );
  }

  if (!existsSync(path.join(packagesDir, dir, "README.md"))) {
    found.push("README.md is missing");
  }

  problems.push(...found.map((problem) => `packages/${dir}: ${problem}`));
}

if (problems.length) {
  console.error("These packages cannot be published as they are:");

  for (const problem of problems) {
    console.error(`  ${problem}`);
  }

  process.exit(1);
}

console.log(
  `${checked} publishable package${checked === 1 ? "" : "s"} follow the publishing rules.`
);
