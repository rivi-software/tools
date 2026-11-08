import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  describePattern,
  isPackageName,
  moduleMatcher,
  projectFiles,
  stateless,
} from "./modules.js";
import type { ModulePattern } from "./modules.js";

/**
 * What the Worker must not carry, and why. A rule names a module, a marker, or both; the Worker
 * breaks it when it holds either.
 */
export interface ForbiddenRule {
  /** The modules the Worker must not hold: a package name, a glob or a regular expression. */
  module?: ModulePattern;
  /**
   * A string or regular expression the Worker's code must not contain, such as a string only
   * dev code has. It finds code that no source map names.
   */
  marker?: string | RegExp;
  /** Why, for the report: `test-only`, `import single icons`. */
  reason: string;
}

/** A built JavaScript file of the Worker. */
export interface WorkerFile {
  /** Its path, as reports show it. */
  path: string;
  code: string;
  /** The bytes of code each module renders in it, by module path; undefined without a map. */
  modules?: ReadonlyMap<string, number>;
}

/** A module the Worker holds, and the bytes of code it renders there. */
export interface BundledModule {
  /** Its path relative to `cwd`, symlinks resolved, with `/` between segments. */
  path: string;
  /** The bytes of generated code it renders in the file. */
  bytes: number;
}

/** A forbidden rule the Worker breaks, in one of its files. */
export type ForbiddenFinding =
  | {
      kind: "forbidden-module";
      rule: ForbiddenRule;
      file: string;
      modules: BundledModule[];
    }
  | { kind: "forbidden-marker"; rule: ForbiddenRule; file: string };

/** The part of a rule that matches nothing the project has. */
export interface StaleRule {
  rule: ForbiddenRule;
  part: "module" | "marker";
}

/** A rule as a message shows it, with its regular expressions readable. */
const show = (rule: ForbiddenRule): string =>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.stringify hands its replacer every value of the rule, whatever its shape
  JSON.stringify(rule, (_, value: unknown) =>
    value instanceof RegExp ? String(value) : value
  );

/** Throws when a rule names neither a module nor a marker, or has no reason. */
export const validateRules = (rules: readonly ForbiddenRule[]): void => {
  for (const rule of rules) {
    if (rule.module === undefined && rule.marker === undefined) {
      throw new TypeError(
        `A forbidden rule names neither a module nor a marker: ${show(rule)}.`
      );
    }

    if (!rule.reason?.trim()) {
      throw new TypeError(`A forbidden rule has no reason: ${show(rule)}.`);
    }
  }
};

/** Whether `code` contains the marker. */
export const hasMarker = (code: string, marker: string | RegExp): boolean =>
  marker instanceof RegExp
    ? stateless(marker).test(code)
    : code.includes(marker);

/** Each rule the Worker's files break, per file. */
export const findForbidden = (
  files: readonly WorkerFile[],
  rules: readonly ForbiddenRule[]
): ForbiddenFinding[] => {
  const findings: ForbiddenFinding[] = [];

  for (const rule of rules) {
    const matches =
      rule.module === undefined ? undefined : moduleMatcher(rule.module);

    for (const file of files) {
      const modules = matches
        ? [...(file.modules ?? [])]
            .flatMap(([modulePath, bytes]) =>
              matches(modulePath) ? [{ path: modulePath, bytes }] : []
            )
            .toSorted(
              (a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)
            )
        : [];

      if (modules.length) {
        findings.push({
          kind: "forbidden-module",
          rule,
          file: file.path,
          modules,
        });
      }

      if (rule.marker !== undefined && hasMarker(file.code, rule.marker)) {
        findings.push({ kind: "forbidden-marker", rule, file: file.path });
      }
    }
  }

  return findings;
};

/** Files read for a marker: code and the text formats that carry it. */
const TEXT = /\.(?:[cm]?[jt]sx?|json|vue|svelte|astro|html?)$/iu;

/** A module path inside an installed package, which is nobody's own code. */
const IN_NODE_MODULES = /(?:^|\/)node_modules\//u;

/** The text of a file, or nothing when it cannot be read. */
const readText = async (file: string): Promise<string | undefined> => {
  let text: string | undefined;

  try {
    text = await readFile(file, "utf-8");
  } catch {
    // A file the check cannot read holds no marker it could find.
  }

  return text;
};

/** Whether a package is installed where Node would find it from `cwd`, or in pnpm's store. */
const installed = (name: string, cwd: string): boolean => {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    for (const base of ["node_modules", "node_modules/.pnpm/node_modules"]) {
      if (existsSync(path.join(dir, base, name, "package.json"))) {
        return true;
      }
    }

    if (dir === path.dirname(dir)) {
      return false;
    }
  }
};

/** A rule whose module or marker the Worker does not settle, and so the project must. */
interface Pending {
  rule: ForbiddenRule;
  matches?: (modulePath: string) => boolean;
  module: boolean;
  marker: boolean;
}

/** The rules with a part left open once the Worker's own files have had their say. */
const openRules = (
  files: readonly WorkerFile[],
  rules: readonly ForbiddenRule[],
  cwd: string
): Pending[] => {
  const pending: Pending[] = [];

  for (const rule of rules) {
    const matches =
      rule.module === undefined ? undefined : moduleMatcher(rule.module);

    const inWorker =
      matches !== undefined &&
      files.some((file) => [...(file.modules?.keys() ?? [])].some(matches));

    const module =
      rule.module !== undefined &&
      !inWorker &&
      !(
        !(rule.module instanceof RegExp) &&
        isPackageName(rule.module) &&
        installed(rule.module, cwd)
      );

    const { marker } = rule;

    const stale =
      marker !== undefined &&
      !files.some((file) => hasMarker(file.code, marker));

    if (module || stale) {
      pending.push({ rule, matches, module, marker: stale });
    }
  }

  return pending;
};

/** Settles what one project file says about one pending rule. */
const settle = async (
  entry: Pending,
  modulePath: string,
  read: () => Promise<string | undefined>
): Promise<void> => {
  const named = entry.matches?.(modulePath);

  if (entry.module && named) {
    entry.module = false;
  }

  if (!entry.marker) {
    return;
  }

  const own =
    !entry.matches &&
    !modulePath.startsWith("../") &&
    !IN_NODE_MODULES.test(modulePath);

  if (!named && !own) {
    return;
  }

  const { marker } = entry.rule;
  const code = await read();

  if (code !== undefined && marker !== undefined && hasMarker(code, marker)) {
    entry.marker = false;
  }
};

/**
 * The rule parts that match nothing: a guard that matches nothing guards nothing, so the list
 * stays current. The Worker should hold none of what the rules name, so a rule is checked
 * against the project instead (see {@link projectFiles}):
 * - a module pattern, against the project's files: a package name needs the package installed,
 *   and a glob or regular expression needs a file it matches
 * - a marker, against the text of the files its rule's module pattern matches; without one,
 *   against the project's own files under `cwd`, outside `node_modules`
 *
 * A part the Worker matches is never stale.
 */
export const findStaleRules = async (
  files: readonly WorkerFile[],
  rules: readonly ForbiddenRule[],
  cwd: string,
  skip: readonly string[]
): Promise<StaleRule[]> => {
  const pending = openRules(files, rules, cwd);
  const open = () => pending.some((entry) => entry.module || entry.marker);

  if (open()) {
    for await (const { path: modulePath, file } of projectFiles(cwd, skip)) {
      let text: Promise<string | undefined> | undefined;

      const read = () =>
        (text ??= TEXT.test(file)
          ? readText(file)
          : Promise.resolve(undefined));

      for (const entry of pending) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the entries share one read of this file, so they settle one after another
        await settle(entry, modulePath, read);
      }

      if (!open()) {
        break;
      }
    }
  }

  return pending.flatMap(({ rule, module, marker }) => [
    ...(module ? [{ rule, part: "module" as const }] : []),
    ...(marker ? [{ rule, part: "marker" as const }] : []),
  ]);
};

/** A rule as reports name it: its reason and what it forbids. */
export const describeRule = (rule: ForbiddenRule): string => {
  const parts = [
    rule.module === undefined
      ? undefined
      : `module ${describePattern(rule.module)}`,
    rule.marker === undefined
      ? undefined
      : `marker ${describePattern(rule.marker)}`,
  ].filter(Boolean);

  return `${parts.join(" and ")} (${rule.reason})`;
};
