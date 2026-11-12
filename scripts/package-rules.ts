/**
 * The rules CONTRIBUTING.md sets for a publishable package, which scripts/check-publish-manifests.ts
 * holds each one in packages/ to: the package.json fields npm publishing relies on
 * (CONTRIBUTING.md#packagejson) and the rest of that template, the LICENSE and README the package
 * ships, and the two places outside it that list it: the root README's table of packages and its
 * `scope:<name>` entry in .github/labeler.yml. Each function returns what is wrong, empty when
 * nothing is.
 */

export const SCOPE = "@rivi-software/";
export const REPOSITORY_URL = "git+https://github.com/rivi-software/tools.git";
export const BUGS_URL = "https://github.com/rivi-software/tools/issues";

/** The scripts the root runs in every package with `pnpm -r run`, which skips a package without one. */
export const SCRIPTS = ["build", "check", "test"] as const;

/** The `homepage` of the package in `packages/<dir>`: its README on GitHub. */
export const homepageUrl = (dir: string): string =>
  `https://github.com/rivi-software/tools/tree/main/packages/${dir}#readme`;

type ExportTarget = string | { [condition: string]: ExportTarget } | null;

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  description?: string;
  license?: string;
  type?: string;
  repository?: string | { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: string | { url?: string; email?: string };
  files?: string[];
  exports?: ExportTarget;
  bin?: string | Record<string, string>;
  sideEffects?: boolean | string[];
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  publishConfig?: { access?: string };
}

/** What manifestProblems knows about a package beyond its manifest. */
export interface ManifestContext {
  /** Whether the package runs in Node, which a `bin` says on its own. */
  runsInNode?: boolean;
}

/** What the check reads from the root of the repository. */
export interface RepositoryFiles {
  license: string;
  readme: string;
  labeler: string;
}

/** What the check reads from `packages/<dir>`: a file is undefined when the package lacks it. */
export interface PackageFiles {
  manifest: Manifest;
  license?: string;
  readme?: string;
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

/** What is wrong with what the manifest says the package is: its name, version and license. */
const identityProblems = (manifest: Manifest): string[] => {
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

  return problems;
};

/** What is wrong with where the manifest points: this repository, the README and the issues. */
const linkProblems = (dir: string, manifest: Manifest): string[] => {
  const problems = repositoryProblems(dir, manifest.repository);

  if (manifest.homepage !== homepageUrl(dir)) {
    problems.push(`"homepage" must be "${homepageUrl(dir)}"`);
  }

  if (manifest.bugs !== BUGS_URL) {
    problems.push(`"bugs" must be "${BUGS_URL}"`);
  }

  return problems;
};

/** What is wrong with what the package ships, and how npm publishes it. */
const shipProblems = (manifest: Manifest): string[] => {
  const problems: string[] = [];

  if (!manifest.files?.includes("dist")) {
    problems.push(`"files" must include "dist"`);
  }

  if (manifest.sideEffects !== false && !Array.isArray(manifest.sideEffects)) {
    problems.push(
      `"sideEffects" must be false, or list the files that have side effects`
    );
  }

  if (manifest.publishConfig?.access !== "public") {
    problems.push(`"publishConfig.access" must be "public"`);
  }

  return [
    ...problems,
    ...exportsProblems(manifest.exports ?? null),
    ...binProblems(manifest.name ?? "", manifest.bin),
  ];
};

/** What is wrong with how the repository builds and tests the package, and where it runs. */
const runProblems = (
  manifest: Manifest,
  context: ManifestContext
): string[] => {
  const problems: string[] = [];

  for (const script of SCRIPTS) {
    if (!manifest.scripts?.[script]) {
      problems.push(
        `"scripts.${script}" is missing; \`pnpm -r run ${script}\` skips a package without it`
      );
    }
  }

  if (
    (context.runsInNode || manifest.bin !== undefined) &&
    !manifest.engines?.node
  ) {
    problems.push(
      `"engines.node" is missing; a package that runs in Node names the versions it supports, such as ">=22"`
    );
  }

  return problems;
};

/**
 * What is wrong with the manifest of the package in `packages/<dir>`; empty when nothing is.
 * `context.runsInNode` asks for `engines.node`, which a package with a `bin` needs anyway.
 */
export const manifestProblems = (
  dir: string,
  manifest: Manifest,
  context: ManifestContext = {}
): string[] => [
  ...identityProblems(manifest),
  ...linkProblems(dir, manifest),
  ...shipProblems(manifest),
  ...runProblems(manifest, context),
];

/** A YAML scalar without the quotes around it. */
const unquote = (value: string): string =>
  /^(?<quote>["'])(?<inner>.*)\k<quote>$/u.exec(value)?.groups?.inner ?? value;

/**
 * The globs each label in .github/labeler.yml matches, by label. It reads the shape that file
 * has, not YAML at large: each label at the top level, and every glob below it as a list item,
 * on its own (`- rivi-bot/**`) or after a key (`- any-glob-to-any-file: packages/<name>/**`).
 */
export const labelerGlobs = (labeler: string): Map<string, string[]> => {
  const globs = new Map<string, string[]>();
  let current: string[] | undefined;

  for (const raw of labeler.split("\n")) {
    const line = raw.replace(/\s+#.*$/u, "").trimEnd();

    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    if (!/^\s/u.test(line)) {
      current = [];
      globs.set(unquote(line.replace(/:$/u, "")), current);
      continue;
    }

    const item = /^\s*-\s+(?:[\w-]+:)?\s*(?<glob>.*)$/u.exec(line)?.groups
      ?.glob;

    if (item) {
      current?.push(unquote(item));
    }
  }

  return globs;
};

/** What is wrong with how .github/labeler.yml maps the package in `packages/<dir>` to its scope. */
export const labelerProblems = (dir: string, labeler: string): string[] => {
  const label = `scope:${dir}`;
  const glob = `packages/${dir}/**`;

  if (labelerGlobs(labeler).get(label)?.includes(glob)) {
    return [];
  }

  return [
    `.github/labeler.yml must map ${label} to ${glob}, or the package's pull requests get no scope label`,
  ];
};

/** The cells of a Markdown table row, split at each `|` that is not escaped. */
const tableCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/u, "")
    .replace(/(?<!\\)\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim());

/** The rows of the table under the README's "## Packages" heading, each by its column names. */
export const packageTable = (readme: string): Record<string, string>[] => {
  const lines = readme.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Packages");
  const table: string[] = [];

  for (const line of heading === -1 ? [] : lines.slice(heading + 1)) {
    if (line.trimStart().startsWith("|")) {
      table.push(line);
    } else if (table.length > 0 || line.startsWith("#")) {
      break;
    }
  }

  const [header, , ...rows] = table.map(tableCells);

  return rows.map((row) =>
    Object.fromEntries(header.map((column, i) => [column, row[i] ?? ""]))
  );
};

/** How the root README's row for the package in `packages/<dir>` starts: its name and link. */
export const readmeLink = (dir: string): string =>
  `[\`${dir}\`](packages/${dir}#readme)`;

/** The root README's row for the package in `packages/<dir>`, by column; undefined when it has none. */
export const readmeRow = (
  dir: string,
  readme: string
): Record<string, string> | undefined =>
  packageTable(readme).find((row) =>
    Object.values(row)[0]?.startsWith(readmeLink(dir))
  );

/**
 * What is wrong with the package in `packages/<dir>`: its manifest, the LICENSE and README it
 * ships, and where the repository lists it. The README's "Runs in" column saying Node asks for
 * `engines.node`.
 */
export const packageProblems = (
  dir: string,
  files: PackageFiles,
  repository: RepositoryFiles
): string[] => {
  const row = readmeRow(dir, repository.readme);

  const problems = manifestProblems(dir, files.manifest, {
    runsInNode: /\bNode\b/u.test(row?.["Runs in"] ?? ""),
  });

  if (files.license !== repository.license) {
    problems.push(
      "LICENSE must be a copy of the root LICENSE; npm ships only the package's own"
    );
  }

  if (files.readme === undefined) {
    problems.push("README.md is missing");
  }

  if (!row) {
    problems.push(
      `the root README's table of packages has no row for it; add one that starts ${readmeLink(dir)}`
    );
  }

  problems.push(...labelerProblems(dir, repository.labeler));

  return problems;
};
