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
const PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

/** Whether a module pattern is a package name. */
export const isPackageName = (pattern: ModulePattern): boolean =>
  !(pattern instanceof RegExp) && PACKAGE_NAME.test(pattern);

/** A module path without the `../` that leads outside `cwd`. */
const matchable = (modulePath: string): string =>
  modulePath.replace(/^(?:\.\.\/)+/u, "");

/** A copy of a regular expression without the `g` and `y` flags, whose `test` keeps state. */
export const stateless = (regExp: RegExp): RegExp =>
  regExp.global || regExp.sticky
    ? new RegExp(regExp.source, regExp.flags.replaceAll(/[gy]/gu, ""))
    : regExp;

/** A test for module paths: whether `pattern` names the module. */
export const moduleMatcher = (
  pattern: ModulePattern
): ((modulePath: string) => boolean) => {
  if (pattern instanceof RegExp) {
    const regExp = stateless(pattern);

    return (modulePath) => regExp.test(matchable(modulePath));
  }

  if (isPackageName(pattern)) {
    const segment = `/node_modules/${pattern}/`;

    return (modulePath) => `/${matchable(modulePath)}`.includes(segment);
  }

  const glob = new Minimatch(pattern.replace(/^\.\//u, ""), { dot: true });

  return (modulePath) => glob.match(matchable(modulePath));
};

/** A pattern or marker as reports show it. */
export const describePattern = (pattern: string | RegExp): string =>
  pattern instanceof RegExp ? String(pattern) : JSON.stringify(pattern);

/** A file of the project: its module path and its absolute real path. */
export interface ProjectFile {
  path: string;
  file: string;
}

/**
 * Every file the project has, for the check of stale rules: the files under `cwd`, and those in
 * the `node_modules` of each directory above it, where a monorepo installs its packages. It
 * follows symlinked directories, each real directory once, and names each file by its real path,
 * as bundlers do. It skips `.git` and the directories in `skip`, the build's output.
 *
 * @yields {ProjectFile} Each file of the project, in the order the walk reaches it.
 */
export const projectFiles = async function* projectFiles(
  cwd: string,
  skip: readonly string[]
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

    if (dir === path.dirname(dir)) {
      break;
    }
  }

  // `queue` grows while it is walked: every directory found below adds itself to the end.
  for (const dir of queue) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the walk reads one directory at a time, so a deep tree never opens thousands of handles at once
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }

      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        yield { path: posixRelative(cwd, file), file };
      } else if (entry.isSymbolicLink()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each link is resolved where the walk meets it, to keep the entries of one directory in order
        const target = await stat(file).catch(() => null);
        const resolved = target && realPath(file);

        if (!resolved) {
          continue;
        }

        if (target.isDirectory()) {
          visit(resolved);
        } else if (target.isFile()) {
          yield { path: posixRelative(cwd, resolved), file: resolved };
        }
      }
    }
  }
};
