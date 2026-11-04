import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Minimatch } from "minimatch";
import { posixRelative, realPath } from "./source-map.js";

/**
 * Which modules a rule names:
 * - a package name, such as `msw` or `@faker-js/faker`: every module in that package, wherever it
 *   is installed
 * - a glob, such as `src/mocks/**` or `**\/icons/all.js`: the module paths it matches
 * - a regular expression: the module paths it matches
 *
 * A module path is relative to the check's `cwd`, with `/` between segments. The leading `../` of
 * a module outside `cwd` is left out before matching, so `node_modules/…` in a monorepo's root
 * matches as `node_modules/…`.
 */
export type ModulePattern = string | RegExp;

/** npm's rules for a package name, which never holds a glob character. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Whether a module pattern is a package name. */
export function isPackageName(pattern: ModulePattern): boolean {
  return typeof pattern === "string" && PACKAGE_NAME.test(pattern);
}

/** A test for module paths: whether `pattern` names the module. */
export function moduleMatcher(pattern: ModulePattern): (modulePath: string) => boolean {
  if (pattern instanceof RegExp) {
    const regExp = stateless(pattern);
    return (modulePath) => regExp.test(matchable(modulePath));
  }
  if (isPackageName(pattern)) {
    const segment = `/node_modules/${pattern}/`;
    return (modulePath) => `/${matchable(modulePath)}`.includes(segment);
  }
  const glob = new Minimatch(pattern.replace(/^\.\//, ""), { dot: true });
  return (modulePath) => glob.match(matchable(modulePath));
}

/** A module path without the `../` that leads outside `cwd`. */
function matchable(modulePath: string): string {
  return modulePath.replace(/^(?:\.\.\/)+/, "");
}

/** A copy of a regular expression without the `g` and `y` flags, whose `test` keeps state. */
export function stateless(regExp: RegExp): RegExp {
  return regExp.global || regExp.sticky
    ? new RegExp(regExp.source, regExp.flags.replace(/[gy]/g, ""))
    : regExp;
}

/** A pattern or marker as reports show it. */
export function describePattern(pattern: string | RegExp): string {
  return typeof pattern === "string" ? JSON.stringify(pattern) : String(pattern);
}

/** A file of the project: its module path and its absolute real path. */
export type ProjectFile = { path: string; file: string };

/**
 * Every file the project has, for the check of stale rules: the files under `cwd`, and those in
 * the `node_modules` of each directory above it, where a monorepo installs its packages. It
 * follows symlinked directories, each real directory once, and names each file by its real path,
 * as bundlers do. It skips `.git` and the directories in `skip`, the build's output.
 */
export async function* projectFiles(
  cwd: string,
  skip: readonly string[],
): AsyncGenerator<ProjectFile> {
  const skipped = new Set(skip.map((dir) => realPath(dir) ?? dir));
  const seen = new Set<string>();
  const queue: string[] = [];
  const visit = (dir: string | undefined) => {
    if (dir && !seen.has(dir) && !skipped.has(dir)) {
      seen.add(dir);
      queue.push(dir);
    }
  };
  visit(realPath(cwd));
  for (let dir = path.dirname(cwd); ; dir = path.dirname(dir)) {
    visit(realPath(path.join(dir, "node_modules")));
    if (dir === path.dirname(dir)) break;
  }

  for (let index = 0; index < queue.length; index++) {
    const dir = queue[index]!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) yield { path: posixRelative(cwd, file), file };
      else if (entry.isSymbolicLink()) {
        const target = await stat(file).catch(() => undefined);
        const resolved = target && realPath(file);
        if (!resolved) continue;
        if (target.isDirectory()) visit(resolved);
        else if (target.isFile()) yield { path: posixRelative(cwd, resolved), file: resolved };
      }
    }
  }
}
