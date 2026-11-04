import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findServedSourceMaps, readAssets } from "./assets.js";
import {
  type BundledModule,
  describeRule,
  findForbidden,
  findStaleRules,
  type ForbiddenRule,
  validateRules,
  type WorkerFile,
} from "./forbidden.js";
import { describePattern, isPackageName } from "./modules.js";
import {
  type AllowedSecret,
  allows,
  describeAllowed,
  findSecrets,
  SECRET_PATTERNS,
  type SecretPattern,
  validateAllowedSecrets,
  validateSecretPatterns,
} from "./secrets.js";
import {
  decodeMappings,
  display,
  readSourceMap,
  realPath,
  renderedSources,
  type ResolvedSourceMap,
  type Segment,
  sourceAt,
} from "./source-map.js";

export type WorkerBundleCheckOptions = {
  /**
   * The Worker's build output: the directory with its JavaScript modules and their source maps,
   * such as `dist/server`. Relative to `cwd`.
   */
  serverDir: string;
  /**
   * The Worker's static assets directory, the one `assets.directory` names in the Wrangler
   * config, such as `dist/client`. Relative to `cwd`. Leave it out for a Worker without assets.
   */
  assetsDir?: string;
  /** The modules and markers the Worker must not carry. */
  forbidden?: readonly ForbiddenRule[];
  /** Findings of values shaped like secrets that are known to be safe. */
  allowedSecrets?: readonly AllowedSecret[];
  /** Kinds of secret to look for besides {@link SECRET_PATTERNS}. */
  secretPatterns?: readonly SecretPattern[];
  /**
   * The directory paths are relative to, and module paths are named from: the project's, with
   * its `node_modules`. Default `process.cwd()`.
   */
  cwd?: string;
};

/** A problem the check found. Paths are relative to `cwd`, with `/` between segments. */
export type WorkerBundleProblem = (
  | {
      /** A Worker file holds modules a rule forbids, largest first. */
      kind: "forbidden-module";
      rule: ForbiddenRule;
      file: string;
      modules: BundledModule[];
    }
  | {
      /** A Worker file contains a forbidden marker. */
      kind: "forbidden-marker";
      rule: ForbiddenRule;
      file: string;
    }
  | {
      /** A rule's module pattern or marker matches nothing the project has. */
      kind: "stale-rule";
      rule: ForbiddenRule;
      part: "module" | "marker";
    }
  | {
      /** A Worker file has no source map, so the rules cannot see its modules. */
      kind: "missing-source-map";
      file: string;
    }
  | {
      /** A `.map` file the assets would serve. */
      kind: "served-source-map";
      file: string;
    }
  | {
      /** A script or style the assets would serve with its source map inline. */
      kind: "inline-source-map";
      file: string;
    }
  | {
      /** A value shaped like a secret, in a Worker file or a served asset. */
      kind: "secret";
      file: string;
      /** The pattern's name. */
      name: string;
      /** The first 16 hexadecimal digits of the value's SHA-256; the value is never reported. */
      fingerprint: string;
      line: number;
      /** The module the value comes from, when the file has a source map. */
      module?: string;
    }
  | {
      /** An allowed secret that matches no finding. */
      kind: "stale-allowed-secret";
      allowed: AllowedSecret;
    }
) & {
  /** The problem in one line, for a report. */
  message: string;
};

/** What the check read, and what it found. */
export type WorkerBundleReport = {
  /** The Worker's build output, as given. */
  serverDir: string;
  /** The Worker's JavaScript files. */
  workerFiles: string[];
  /** How many modules the Worker's source maps name. */
  modules: number;
  /** The assets directory, when one was given. */
  assetsDir?: string;
  /** How many files Wrangler would upload from the assets directory. */
  servedAssets: number;
  /** How many files its `.assetsignore` leaves out. */
  ignoredAssets: number;
  /** How many findings of secrets the allow-list let through. */
  allowedSecrets: number;
  problems: WorkerBundleProblem[];
};

/** Thrown by {@link checkWorkerBundle} when it finds problems: they are in `report.problems`. */
export class WorkerBundleCheckError extends Error {
  readonly report: WorkerBundleReport;

  constructor(report: WorkerBundleReport) {
    const count = report.problems.length;
    super(
      [
        `The Worker bundle check found ${count} problem${count === 1 ? "" : "s"}:`,
        ...report.problems.map((problem) => `  ${problem.message}`),
      ].join("\n"),
    );
    this.name = "WorkerBundleCheckError";
    this.report = report;
  }
}

/**
 * Checks a Worker's build: no forbidden module or marker in the Worker, no source map among the
 * assets Wrangler would serve, and no value shaped like a secret in either. Resolves to the
 * report when it finds nothing; rejects with a {@link WorkerBundleCheckError} that lists the
 * problems otherwise. Run it after the build.
 */
export async function checkWorkerBundle(
  options: WorkerBundleCheckOptions,
): Promise<WorkerBundleReport> {
  const report = await inspect(options);
  if (report.problems.length) throw new WorkerBundleCheckError(report);
  return report;
}

/** The Worker's files that can carry a secret: scripts, markup and data. */
const TEXT = /\.(?:[cm]?js|json|html?|css|txt|xml|svg|webmanifest)$/i;
const SCRIPT = /\.[cm]?js$/i;
/**
 * Served files the secret check passes over: source maps, which are a problem of their own, and
 * binary formats. It reads any other served file, such as a stray `.env`, and passes over one
 * that holds a NUL byte near its start.
 */
const NOT_TEXT =
  /\.(?:map|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|m4a|aac|og[ag]|wav|flac|webm|mov|avi|wasm|zip|gz|br|zst|tar|pdf|bin)$/i;

type BuiltFile = WorkerFile & {
  file: string;
  sourceMap?: ResolvedSourceMap;
  mappings?: Segment[][];
};

async function inspect(options: WorkerBundleCheckOptions): Promise<WorkerBundleReport> {
  const given = path.resolve(options.cwd ?? ".");
  const cwd = realPath(given) ?? given;
  const serverDir = path.resolve(cwd, options.serverDir);
  const assetsDir =
    options.assetsDir === undefined ? undefined : path.resolve(cwd, options.assetsDir);
  const rules = options.forbidden ?? [];
  const allowed = options.allowedSecrets ?? [];
  const patterns = [...SECRET_PATTERNS, ...(options.secretPatterns ?? [])];
  validateRules(rules);
  validateAllowedSecrets(allowed);
  validateSecretPatterns(options.secretPatterns ?? []);
  const show = (file: string) => display(file, cwd);
  const problems: WorkerBundleProblem[] = [];

  const texts = new Map<string, Promise<string>>();
  const text = (file: string) => {
    let found = texts.get(file);
    if (!found) texts.set(file, (found = readFile(file, "utf8")));
    return found;
  };
  /**
   * A file with its modules, when it is a script with a source map. A Worker's map must be
   * readable; a served asset's only names where a secret comes from, so an unreadable one is
   * passed over.
   */
  const read = async (file: string, asset = false): Promise<BuiltFile> => {
    const code = await text(file);
    const sourceMap = SCRIPT.test(file)
      ? await readSourceMap(file, code, cwd).catch((error: unknown) => {
          if (asset) return undefined;
          throw error;
        })
      : undefined;
    if (!sourceMap) return { file, path: show(file), code };
    const mappings = decodeMappings(sourceMap.map.mappings);
    const modules = new Map<string, number>();
    for (const [source, bytes] of renderedSources(code, mappings)) {
      const name = sourceMap.modules[source];
      if (name) modules.set(name, (modules.get(name) ?? 0) + bytes);
    }
    return { file, path: show(file), code, sourceMap, mappings, modules };
  };

  // The Worker: every file in its build output, but the assets when they are inside it.
  const entries = await readdir(serverDir, { recursive: true, withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(`There is no Worker build at ${show(serverDir)}: run the build first.`);
      throw error;
    },
  );
  const inAssets = (file: string) =>
    assetsDir !== undefined && !path.relative(assetsDir, file).startsWith("..");
  const serverFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !inAssets(file))
    .sort();
  const workerFiles = await Promise.all(
    serverFiles.filter((file) => SCRIPT.test(file)).map((file) => read(file)),
  );
  if (!workerFiles.length)
    throw new Error(
      `${show(serverDir)} holds no JavaScript. Pass the directory the Worker's build writes its modules to, such as dist/server.`,
    );

  // Forbidden modules and markers.
  if (rules.some((rule) => rule.module !== undefined))
    for (const file of workerFiles)
      if (!file.modules)
        problems.push({
          kind: "missing-source-map",
          file: file.path,
          message: `${file.path} has no source map, so the rules cannot see the modules in it. Build the Worker with source maps.`,
        });
  for (const finding of findForbidden(workerFiles, rules)) {
    if (finding.kind === "forbidden-marker")
      problems.push({
        ...finding,
        message: `${finding.file} contains the marker ${describePattern(finding.rule.marker!)}, which is forbidden: ${finding.rule.reason}.`,
      });
    else {
      const [largest] = finding.modules;
      const count = finding.modules.length;
      const total = finding.modules.reduce((sum, module) => sum + module.bytes, 0);
      problems.push({
        ...finding,
        message:
          count === 1
            ? `${finding.file} holds ${largest!.path} (${kB(largest!.bytes)}), which ${describePattern(finding.rule.module!)} forbids: ${finding.rule.reason}.`
            : `${finding.file} holds ${count} modules (${kB(total)}) that ${describePattern(finding.rule.module!)} forbids: ${finding.rule.reason}. The largest is ${largest!.path} (${kB(largest!.bytes)}).`,
      });
    }
  }
  const skip = [serverDir, ...(assetsDir === undefined ? [] : [assetsDir])];
  for (const { rule, part } of await findStaleRules(workerFiles, rules, cwd, skip))
    problems.push({
      kind: "stale-rule",
      rule,
      part,
      message: `The rule against ${describeRule(rule)} guards nothing: ${staleReason(rule, part)}. Update the rule or remove it.`,
    });

  // The assets Wrangler would serve.
  const assets =
    assetsDir === undefined
      ? undefined
      : await readAssets(assetsDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT")
            throw new Error(`There are no assets at ${show(assetsDir)}: run the build first.`);
          throw error;
        });
  const assetsIgnore = assetsDir === undefined ? "" : show(path.join(assetsDir, ".assetsignore"));
  for (const { kind, file } of await findServedSourceMaps(assets?.served ?? [], text))
    problems.push(
      kind === "served-source-map"
        ? {
            kind,
            file: show(file),
            message: `${show(file)} is a source map Wrangler would serve: leave it out with ${assetsIgnore}, or delete it before the deploy.`,
          }
        : {
            kind,
            file: show(file),
            message: `${show(file)} would be served with its source map inline. Build it with external or hidden source maps.`,
          },
    );

  // Values shaped like secrets, in the Worker and in what the assets serve.
  const plain = async (file: string): Promise<BuiltFile> => ({
    file,
    path: show(file),
    code: await text(file),
  });
  const scanned: BuiltFile[] = [
    ...workerFiles,
    ...(await Promise.all(
      serverFiles.filter((file) => TEXT.test(file) && !SCRIPT.test(file)).map(plain),
    )),
    ...(
      await Promise.all(
        (assets?.served ?? [])
          .filter(({ file }) => !NOT_TEXT.test(file))
          .map(({ file }) => plain(file)),
      )
    ).filter(({ code }) => !code.slice(0, 8000).includes("\0")),
  ];
  const used = new Set<AllowedSecret>();
  let allowedCount = 0;
  for (const scannedFile of scanned) {
    const findings = findSecrets(scannedFile.code, patterns);
    if (!findings.length) continue;
    // A served script's map is read only to name where a value comes from.
    const file = workerFiles.includes(scannedFile)
      ? scannedFile
      : await read(scannedFile.file, true);
    for (const finding of findings) {
      const source =
        file.mappings && file.sourceMap
          ? sourceAt(file.mappings, finding.line - 1, finding.column)
          : -1;
      const module = source >= 0 ? file.sourceMap!.modules[source] : undefined;
      const covering = allowed.filter((entry) => allows(entry, finding, module));
      if (covering.length) {
        for (const entry of covering) used.add(entry);
        allowedCount++;
        continue;
      }
      problems.push({
        kind: "secret",
        file: file.path,
        name: finding.name,
        fingerprint: finding.fingerprint,
        line: finding.line,
        ...(module === undefined ? {} : { module }),
        message: `${file.path}:${finding.line} holds a value shaped like a ${finding.name}${module === undefined ? "" : `, from ${module}`} (fingerprint ${finding.fingerprint}).`,
      });
    }
  }
  for (const entry of allowed)
    if (!used.has(entry))
      problems.push({
        kind: "stale-allowed-secret",
        allowed: entry,
        message: `The allowed secret with ${describeAllowed(entry)} (${entry.reason}) matches no finding. Remove it.`,
      });

  return {
    serverDir: show(serverDir),
    workerFiles: workerFiles.map((file) => file.path),
    modules: new Set(workerFiles.flatMap((file) => [...(file.modules?.keys() ?? [])])).size,
    ...(assetsDir === undefined ? {} : { assetsDir: show(assetsDir) }),
    servedAssets: assets?.served.length ?? 0,
    ignoredAssets: assets?.ignored.length ?? 0,
    allowedSecrets: allowedCount,
    problems,
  };
}

function staleReason(rule: ForbiddenRule, part: "module" | "marker"): string {
  if (part === "module")
    return isPackageName(rule.module!)
      ? `no package ${describePattern(rule.module!)} is installed`
      : `no file matches ${describePattern(rule.module!)}`;
  return rule.module === undefined
    ? `no file of the project, outside node_modules, contains ${describePattern(rule.marker!)}`
    : `no file that ${describePattern(rule.module)} matches contains ${describePattern(rule.marker!)}`;
}

function kB(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`;
}
