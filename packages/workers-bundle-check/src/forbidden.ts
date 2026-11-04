import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  describePattern,
  isPackageName,
  moduleMatcher,
  type ModulePattern,
  projectFiles,
  stateless,
} from "./modules.js";

/**
 * What the Worker must not carry, and why. A rule names a module, a marker, or both; the Worker
 * breaks it when it holds either.
 */
export type ForbiddenRule = {
  /** The modules the Worker must not hold: a package name, a glob or a regular expression. */
  module?: ModulePattern;
  /**
   * A string or regular expression the Worker's code must not contain, such as a string only
   * dev code has. It finds code that no source map names.
   */
  marker?: string | RegExp;
  /** Why, for the report: `test-only`, `import single icons`. */
  reason: string;
};

/** A built JavaScript file of the Worker. */
export type WorkerFile = {
  /** Its path, as reports show it. */
  path: string;
  code: string;
  /** The bytes of code each module renders in it, by module path; undefined without a map. */
  modules?: ReadonlyMap<string, number>;
};

/** A module the Worker holds, and the bytes of code it renders there. */
export type BundledModule = { path: string; bytes: number };

/** A forbidden rule the Worker breaks, in one of its files. */
export type ForbiddenFinding =
  | { kind: "forbidden-module"; rule: ForbiddenRule; file: string; modules: BundledModule[] }
  | { kind: "forbidden-marker"; rule: ForbiddenRule; file: string };

/** The part of a rule that matches nothing the project has. */
export type StaleRule = { rule: ForbiddenRule; part: "module" | "marker" };

/** Throws when a rule names neither a module nor a marker, or has no reason. */
export function validateRules(rules: readonly ForbiddenRule[]): void {
  for (const rule of rules) {
    if (rule.module === undefined && rule.marker === undefined)
      throw new TypeError(`A forbidden rule names neither a module nor a marker: ${show(rule)}.`);
    if (!rule.reason?.trim()) throw new TypeError(`A forbidden rule has no reason: ${show(rule)}.`);
  }
}

function show(rule: ForbiddenRule): string {
  return JSON.stringify(rule, (_, value: unknown) =>
    value instanceof RegExp ? String(value) : value,
  );
}

/** Whether `code` contains the marker. */
export function hasMarker(code: string, marker: string | RegExp): boolean {
  return typeof marker === "string" ? code.includes(marker) : stateless(marker).test(code);
}

/** Each rule the Worker's files break, per file. */
export function findForbidden(
  files: readonly WorkerFile[],
  rules: readonly ForbiddenRule[],
): ForbiddenFinding[] {
  const findings: ForbiddenFinding[] = [];
  for (const rule of rules) {
    const matches = rule.module === undefined ? undefined : moduleMatcher(rule.module);
    for (const file of files) {
      const modules = matches
        ? [...(file.modules ?? [])]
            .filter(([modulePath]) => matches(modulePath))
            .map(([modulePath, bytes]) => ({ path: modulePath, bytes }))
            .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
        : [];
      if (modules.length)
        findings.push({ kind: "forbidden-module", rule, file: file.path, modules });
      if (rule.marker !== undefined && hasMarker(file.code, rule.marker))
        findings.push({ kind: "forbidden-marker", rule, file: file.path });
    }
  }
  return findings;
}

/** Files read for a marker: code and the text formats that carry it. */
const TEXT = /\.(?:[cm]?[jt]sx?|json|vue|svelte|astro|html?)$/i;

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
export async function findStaleRules(
  files: readonly WorkerFile[],
  rules: readonly ForbiddenRule[],
  cwd: string,
  skip: readonly string[],
): Promise<StaleRule[]> {
  type Pending = {
    rule: ForbiddenRule;
    matches?: (modulePath: string) => boolean;
    module: boolean;
    marker: boolean;
  };
  const pending: Pending[] = [];
  for (const rule of rules) {
    const matches = rule.module === undefined ? undefined : moduleMatcher(rule.module);
    const inWorker =
      matches !== undefined &&
      files.some((file) => [...(file.modules?.keys() ?? [])].some(matches));
    const module =
      rule.module !== undefined &&
      !inWorker &&
      !(
        typeof rule.module === "string" &&
        isPackageName(rule.module) &&
        installed(rule.module, cwd)
      );
    const marker =
      rule.marker !== undefined && !files.some((file) => hasMarker(file.code, rule.marker!));
    if (module || marker) pending.push({ rule, matches, module, marker });
  }

  const open = () => pending.some((entry) => entry.module || entry.marker);
  if (open())
    for await (const { path: modulePath, file } of projectFiles(cwd, skip)) {
      let text: Promise<string | undefined> | undefined;
      const read = () =>
        (text ??= TEXT.test(file)
          ? readFile(file, "utf8").catch(() => undefined)
          : Promise.resolve(undefined));
      for (const entry of pending) {
        const named = entry.matches?.(modulePath);
        if (entry.module && named) entry.module = false;
        if (!entry.marker) continue;
        const own =
          !entry.matches &&
          !modulePath.startsWith("../") &&
          !/(?:^|\/)node_modules\//.test(modulePath);
        if (!named && !own) continue;
        const code = await read();
        if (code !== undefined && hasMarker(code, entry.rule.marker!)) entry.marker = false;
      }
      if (!open()) break;
    }

  return pending.flatMap(({ rule, module, marker }) => [
    ...(module ? [{ rule, part: "module" as const }] : []),
    ...(marker ? [{ rule, part: "marker" as const }] : []),
  ]);
}

/** Whether a package is installed where Node would find it from `cwd`, or in pnpm's store. */
function installed(name: string, cwd: string): boolean {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    for (const base of ["node_modules", "node_modules/.pnpm/node_modules"])
      if (existsSync(path.join(dir, base, name, "package.json"))) return true;
    if (dir === path.dirname(dir)) return false;
  }
}

/** A rule as reports name it: its reason and what it forbids. */
export function describeRule(rule: ForbiddenRule): string {
  const parts = [
    rule.module === undefined ? undefined : `module ${describePattern(rule.module)}`,
    rule.marker === undefined ? undefined : `marker ${describePattern(rule.marker)}`,
  ].filter(Boolean);
  return `${parts.join(" and ")} (${rule.reason})`;
}
