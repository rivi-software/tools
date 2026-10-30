/**
 * Fails when a publishable package breaks the rules npm publishing relies on
 * (CONTRIBUTING.md#packagejson): the @rivi-software scope, the MIT license with its text in the
 * package, the repository field npm's provenance check compares with this repository, `exports`,
 * `bin` and `files` that name built files in dist/ (each entry point with its types), and public
 * access. Private packages are skipped.
 *   node scripts/check-publish-manifests.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SCOPE = "@rivi-software/";
export const REPOSITORY_URL = "git+https://github.com/rivi-software/tools.git";

type ExportTarget = string | { [condition: string]: ExportTarget } | null;

export type Manifest = {
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
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Every file an `exports` entry names, by its subpath and condition. */
function exportTargets(exports: ExportTarget, path: string): { path: string; target: string }[] {
  if (typeof exports === "string") return [{ path, target: exports }];
  if (!exports) return [];
  return Object.entries(exports).flatMap(([key, value]) =>
    exportTargets(value, key.startsWith(".") ? key : `${path} ${key}`),
  );
}

/** What is wrong with the manifest of the package in `packages/<dir>`; empty when nothing is. */
export function manifestProblems(dir: string, manifest: Manifest): string[] {
  const problems: string[] = [];
  const name = manifest.name ?? "";
  if (!name.startsWith(SCOPE) || name.length === SCOPE.length)
    problems.push(`"name" must be ${SCOPE}<name>, not "${name}"`);
  if (!SEMVER.test(manifest.version ?? ""))
    problems.push(`"version" must be a semver version, not "${manifest.version}"`);
  if (!manifest.description?.trim()) problems.push(`"description" is missing`);
  if (manifest.license !== "MIT") problems.push(`"license" must be "MIT"`);
  if (manifest.type !== "module") problems.push(`"type" must be "module"`);

  const repository = typeof manifest.repository === "object" ? manifest.repository : undefined;
  if (
    repository?.type !== "git" ||
    repository.url !== REPOSITORY_URL ||
    repository.directory !== `packages/${dir}`
  )
    problems.push(
      `"repository" must be { "type": "git", "url": "${REPOSITORY_URL}", "directory": "packages/${dir}" }; npm refuses a trusted publish whose repository differs`,
    );

  if (!manifest.files?.includes("dist")) problems.push(`"files" must include "dist"`);
  if (manifest.publishConfig?.access !== "public")
    problems.push(`"publishConfig.access" must be "public"`);

  const exports = manifest.exports;
  if (!exports || typeof exports !== "object") problems.push(`"exports" must be an object`);
  else {
    for (const [subpath, target] of Object.entries(exports)) {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        problems.push(`"exports" "${subpath}" must be { "types": …, "default": … }`);
        continue;
      }
      const conditions = Object.keys(target);
      if (conditions[0] !== "types" || !conditions.includes("default"))
        problems.push(`"exports" "${subpath}" must list "types" first and include "default"`);
    }
    for (const { path, target } of exportTargets(exports, "."))
      if (!target.startsWith("./dist/"))
        problems.push(`"exports" "${path}" names ${target}, which is not in ./dist/`);
  }

  const bins = typeof manifest.bin === "string" ? { [name]: manifest.bin } : (manifest.bin ?? {});
  for (const [command, target] of Object.entries(bins))
    if (!target.startsWith("./dist/") || !target.endsWith(".js"))
      problems.push(`"bin" "${command}" names ${target}, which is not a .js file in ./dist/`);

  return problems;
}

const root = join(import.meta.dirname, "..");
const license = readFileSync(join(root, "LICENSE"), "utf8");
const packagesDir = join(root, "packages");
const problems: string[] = [];
let checked = 0;
for (const dir of existsSync(packagesDir) ? readdirSync(packagesDir).sort() : []) {
  const file = join(packagesDir, dir, "package.json");
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  if (manifest.private === true) continue;
  checked++;
  const found = manifestProblems(dir, manifest);
  const packageLicense = join(packagesDir, dir, "LICENSE");
  if (!existsSync(packageLicense) || readFileSync(packageLicense, "utf8") !== license)
    found.push("LICENSE must be a copy of the root LICENSE; npm ships only the package's own");
  if (!existsSync(join(packagesDir, dir, "README.md"))) found.push("README.md is missing");
  problems.push(...found.map((problem) => `packages/${dir}: ${problem}`));
}
if (problems.length) {
  console.error("These packages cannot be published as they are:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `${checked} publishable package${checked === 1 ? "" : "s"} follow the publishing rules.`,
);
