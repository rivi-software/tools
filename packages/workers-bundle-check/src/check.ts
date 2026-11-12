import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { findServedSourceMaps, isFile, readAssets } from "./assets.js";
import type { AssetFile, Assets } from "./assets.js";
import {
  describeRule,
  findForbidden,
  findStaleRules,
  validateRules,
} from "./forbidden.js";
import type { BundledModule, ForbiddenRule, WorkerFile } from "./forbidden.js";
import { describePattern, isPackageName } from "./modules.js";
import {
  allows,
  describeAllowed,
  findSecrets,
  SECRET_PATTERNS,
  validateAllowedSecrets,
  validateSecretPatterns,
} from "./secrets.js";
import type { AllowedSecret, SecretPattern } from "./secrets.js";
import {
  decodeMappings,
  display,
  posixRelative,
  readSourceMap,
  realPath,
  renderedSources,
  sourceAt,
} from "./source-map.js";
import type { ResolvedSourceMap, Segment } from "./source-map.js";

export interface WorkerBundleCheckOptions {
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
}

/** A problem the check found. Paths are relative to `cwd`, with `/` between segments. */
export type WorkerBundleProblem = (
  | {
      /** A Worker file holds modules a rule forbids, largest first. */
      kind: "forbidden-module";
      /** The rule the modules break. */
      rule: ForbiddenRule;
      /** The Worker file that holds them. */
      file: string;
      /** The modules the rule's pattern matches, and the bytes each renders in the file. */
      modules: BundledModule[];
    }
  | {
      /** A Worker file contains a forbidden marker. */
      kind: "forbidden-marker";
      /** The rule whose marker the file contains. */
      rule: ForbiddenRule;
      /** The Worker file that contains it. */
      file: string;
    }
  | {
      /** A rule's module pattern or marker matches nothing the project has. */
      kind: "stale-rule";
      /** The rule that guards nothing. */
      rule: ForbiddenRule;
      /** The part of it that matches nothing. */
      part: "module" | "marker";
    }
  | {
      /** A Worker file has no source map, so the rules cannot see its modules. */
      kind: "missing-source-map";
      /** The Worker file without a map. */
      file: string;
    }
  | {
      /** A `.map` file the assets would serve. */
      kind: "served-source-map";
      /** The map, in the assets directory. */
      file: string;
    }
  | {
      /** A script or style the assets would serve with its source map inline. */
      kind: "inline-source-map";
      /** The script or style, in the assets directory. */
      file: string;
    }
  | {
      /** A value shaped like a secret, in a Worker file or a served asset. */
      kind: "secret";
      /** The Worker file or served asset that holds the value. */
      file: string;
      /** The pattern's name. */
      name: string;
      /** The first 16 hexadecimal digits of the value's SHA-256; the value is never reported. */
      fingerprint: string;
      /** The line the value is on, from 1. */
      line: number;
      /** The module the value comes from, when the file has a source map. */
      module?: string;
    }
  | {
      /** An allowed secret that matches no finding. */
      kind: "stale-allowed-secret";
      /** The entry of `allowedSecrets` that matches nothing. */
      allowed: AllowedSecret;
    }
) & {
  /** The problem in one line, for a report. */
  message: string;
};

/** What the check read, and what it found. */
export interface WorkerBundleReport {
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
  /** What the check found. {@link checkWorkerBundle} throws when it finds any. */
  problems: WorkerBundleProblem[];
}

/** Thrown by {@link checkWorkerBundle} when it finds problems: they are in `report.problems`. */
export class WorkerBundleCheckError extends Error {
  readonly report: WorkerBundleReport;

  constructor(report: WorkerBundleReport) {
    const count = report.problems.length;
    super(
      [
        `The Worker bundle check found ${count} problem${count === 1 ? "" : "s"}:`,
        ...report.problems.map((problem) => `  ${problem.message}`),
      ].join("\n")
    );
    this.name = "WorkerBundleCheckError";
    this.report = report;
  }
}

/** The Worker's files that can carry a secret: scripts, markup and data. */
const TEXT = /\.(?:[cm]?js|json|html?|css|txt|xml|svg|webmanifest)$/iu;
const SCRIPT = /\.[cm]?js$/iu;

/**
 * Served files the secret check passes over: source maps, which are a problem of their own, and
 * binary formats. It reads any other served file, such as a stray `.env`, and passes over one
 * that holds a NUL byte near its start.
 */
const NOT_TEXT =
  /\.(?:map|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|m4a|aac|og[ag]|wav|flac|webm|mov|avi|wasm|zip|gz|br|zst|tar|pdf|bin)$/iu;

type BuiltFile = WorkerFile & {
  file: string;
  sourceMap?: ResolvedSourceMap;
  mappings?: Segment[][];
};

/**
 * A built script's source map. A Worker's must be readable; a served asset's only names where a
 * secret comes from, so an unreadable one is passed over.
 */
const mapOf = async (
  file: string,
  code: string,
  cwd: string,
  asset: boolean
): Promise<ResolvedSourceMap | undefined> => {
  try {
    return await readSourceMap(file, code, cwd);
  } catch (error) {
    if (asset) {
      return;
    }

    throw error;
  }
};

const kB = (bytes: number): string =>
  bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`;

/** A rule's module pattern or marker as a report names it. */
const patternOf = (pattern: string | RegExp | undefined): string =>
  pattern === undefined ? "" : describePattern(pattern);

/** Why a rule's part guards nothing. */
const staleReason = (
  rule: ForbiddenRule,
  part: "module" | "marker"
): string => {
  const { module, marker } = rule;

  if (part === "module") {
    return module !== undefined && isPackageName(module)
      ? `no package ${patternOf(module)} is installed`
      : `no file matches ${patternOf(module)}`;
  }

  return module === undefined
    ? `no file of the project, outside node_modules, contains ${patternOf(marker)}`
    : `no file that ${describePattern(module)} matches contains ${patternOf(marker)}`;
};

/** The Worker files without a source map, which hide their modules from the module rules. */
const missingMapProblems = (
  workerFiles: readonly BuiltFile[],
  rules: readonly ForbiddenRule[]
): WorkerBundleProblem[] =>
  rules.some((rule) => rule.module !== undefined)
    ? workerFiles.flatMap((file) =>
        file.modules
          ? []
          : [
              {
                kind: "missing-source-map" as const,
                file: file.path,
                message: `${file.path} has no source map, so the rules cannot see the modules in it. Build the Worker with source maps.`,
              },
            ]
      )
    : [];

/** The forbidden modules and markers the Worker's files hold. */
const forbiddenProblems = (
  workerFiles: readonly BuiltFile[],
  rules: readonly ForbiddenRule[]
): WorkerBundleProblem[] =>
  findForbidden(workerFiles, rules).map((finding) => {
    if (finding.kind === "forbidden-marker") {
      return {
        ...finding,
        message: `${finding.file} contains the marker ${patternOf(finding.rule.marker)}, which is forbidden: ${finding.rule.reason}.`,
      };
    }

    // oxlint-disable-next-line typescript/no-non-null-assertion -- findForbidden reports this kind only where the pattern matched a module, largest first
    const largest = finding.modules[0]!;
    const count = finding.modules.length;
    const forbids = patternOf(finding.rule.module);

    const total = finding.modules.reduce(
      (sum, module) => sum + module.bytes,
      0
    );

    return {
      ...finding,
      message:
        count === 1
          ? `${finding.file} holds ${largest.path} (${kB(largest.bytes)}), which ${forbids} forbids: ${finding.rule.reason}.`
          : `${finding.file} holds ${count} modules (${kB(total)}) that ${forbids} forbids: ${finding.rule.reason}. The largest is ${largest.path} (${kB(largest.bytes)}).`,
    };
  });

/** The source maps the assets would serve, as problems. */
const servedMapProblems = async (
  served: readonly AssetFile[],
  text: (file: string) => Promise<string>,
  show: (file: string) => string,
  assetsIgnore: string
): Promise<WorkerBundleProblem[]> => {
  const found = await findServedSourceMaps(served, text);

  return found.map(({ kind, file }) =>
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
        }
  );
};

/** What the secret check found, and which allowed entries it used. */
interface SecretScan {
  problems: WorkerBundleProblem[];
  allowedCount: number;
  used: Set<AllowedSecret>;
}

/** The values shaped like secrets in the scanned files, minus the ones the allow-list covers. */
const scanSecrets = async (
  scanned: readonly BuiltFile[],
  workerFiles: readonly BuiltFile[],
  patterns: readonly SecretPattern[],
  allowed: readonly AllowedSecret[],
  read: (file: string, asset?: boolean) => Promise<BuiltFile>
): Promise<SecretScan> => {
  const problems: WorkerBundleProblem[] = [];
  const used = new Set<AllowedSecret>();
  let allowedCount = 0;

  for (const scannedFile of scanned) {
    const findings = findSecrets(scannedFile.code, patterns);

    if (!findings.length) {
      continue;
    }

    // A served script's map is read only to name where a value comes from.
    let file = scannedFile;

    if (!workerFiles.includes(scannedFile)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- only a file that holds a finding is read again, and one at a time
      file = await read(scannedFile.file, true);
    }

    const { mappings, sourceMap } = file;

    for (const finding of findings) {
      const source =
        mappings && sourceMap
          ? sourceAt(mappings, finding.line - 1, finding.column)
          : -1;

      const module =
        source >= 0 && sourceMap ? sourceMap.modules[source] : undefined;

      const covering = allowed.filter((entry) =>
        allows(entry, finding, module)
      );

      if (covering.length) {
        for (const entry of covering) {
          used.add(entry);
        }

        allowedCount += 1;
        continue;
      }

      const base = {
        kind: "secret" as const,
        file: file.path,
        name: finding.name,
        fingerprint: finding.fingerprint,
        line: finding.line,
      };

      const message = `${file.path}:${finding.line} holds a value shaped like a ${finding.name}${module === undefined ? "" : `, from ${module}`} (fingerprint ${finding.fingerprint}).`;

      problems.push(
        module === undefined
          ? { ...base, message }
          : { ...base, module, message }
      );
    }
  }

  return { problems, allowedCount, used };
};

/** Whether `file` is `dir` or lies under it. */
const isWithin = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);

  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/**
 * The files under `dir`, as Wrangler's walk for a Worker's modules (`getFiles`) finds them: a
 * link to a file counts as that file, and a link to a directory is not followed.
 */
const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });

  const found = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        return filesUnder(file);
      }

      const counts =
        entry.isFile() || (entry.isSymbolicLink() && (await isFile(file)));

      return counts ? [file] : [];
    })
  );

  return found.flat();
};

/** Every file of the Worker's build output, but the assets when they live inside it. */
const serverBuildFiles = async (
  serverDir: string,
  assetsDir: string | undefined,
  show: (file: string) => string
): Promise<string[]> => {
  const files = await filesUnder(serverDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(
          `There is no Worker build at ${show(serverDir)}: run the build first.`
        );
      }

      throw error;
    }
  );

  return files
    .filter((file) => assetsDir === undefined || !isWithin(assetsDir, file))
    .toSorted();
};

/** The assets directory's files, with a clearer error when the build has not run. */
const buildAssets = async (
  assetsDir: string,
  show: (file: string) => string
): Promise<Assets> => {
  const assets = await readAssets(assetsDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(
          `There are no assets at ${show(assetsDir)}: run the build first.`
        );
      }

      throw error;
    }
  );

  return assets;
};

const inspect = async (
  options: WorkerBundleCheckOptions
): Promise<WorkerBundleReport> => {
  const given = path.resolve(options.cwd ?? ".");
  const cwd = realPath(given) ?? given;
  const serverDir = path.resolve(cwd, options.serverDir);

  const assetsDir =
    options.assetsDir === undefined
      ? undefined
      : path.resolve(cwd, options.assetsDir);

  const rules = options.forbidden ?? [];
  const allowed = options.allowedSecrets ?? [];
  const extra = options.secretPatterns ?? [];
  const patterns = [...SECRET_PATTERNS, ...extra];
  validateRules(rules);
  validateAllowedSecrets(allowed);
  validateSecretPatterns(extra);

  /**
   * A path as reports show it. A file in the assets or the Worker's build is named by its path
   * there, the one Wrangler uploads it by, also when it is a link or sits in a linked directory.
   */
  const show = (file: string): string => {
    const dir = [assetsDir, serverDir].find(
      (candidate) => candidate !== undefined && isWithin(candidate, file)
    );

    return dir === undefined
      ? display(file, cwd)
      : path.posix.join(display(dir, cwd), posixRelative(dir, file));
  };

  const texts = new Map<string, Promise<string>>();

  const text = (file: string) => {
    let found = texts.get(file);

    if (!found) {
      texts.set(file, (found = readFile(file, "utf-8")));
    }

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
      ? await mapOf(file, code, cwd, asset)
      : undefined;

    if (!sourceMap) {
      return { file, path: show(file), code };
    }

    const mappings = decodeMappings(sourceMap.map.mappings);
    const modules = new Map<string, number>();

    for (const [source, bytes] of renderedSources(code, mappings)) {
      const name = sourceMap.modules[source];

      if (name) {
        modules.set(name, (modules.get(name) ?? 0) + bytes);
      }
    }

    return { file, path: show(file), code, sourceMap, mappings, modules };
  };

  const serverFiles = await serverBuildFiles(serverDir, assetsDir, show);

  const workerFiles = await Promise.all(
    serverFiles.filter((file) => SCRIPT.test(file)).map((file) => read(file))
  );

  if (!workerFiles.length) {
    throw new Error(
      `${show(serverDir)} holds no JavaScript. Pass the directory the Worker's build writes its modules to, such as dist/server.`
    );
  }

  const skip = [serverDir, ...(assetsDir === undefined ? [] : [assetsDir])];
  const stale = await findStaleRules(workerFiles, rules, cwd, skip);

  const problems: WorkerBundleProblem[] = [
    ...missingMapProblems(workerFiles, rules),
    ...forbiddenProblems(workerFiles, rules),
    ...stale.map(({ rule, part }) => ({
      kind: "stale-rule" as const,
      rule,
      part,
      message: `The rule against ${describeRule(rule)} guards nothing: ${staleReason(rule, part)}. Update the rule or remove it.`,
    })),
  ];

  // The assets Wrangler would serve.
  const assets: Assets =
    assetsDir === undefined
      ? { served: [], ignored: [] }
      : await buildAssets(assetsDir, show);

  const assetsIgnore =
    assetsDir === undefined ? "" : show(path.join(assetsDir, ".assetsignore"));

  problems.push(
    ...(await servedMapProblems(assets.served, text, show, assetsIgnore))
  );

  // Values shaped like secrets, in the Worker and in what the assets serve.
  const plain = async (file: string): Promise<BuiltFile> => ({
    file,
    path: show(file),
    code: await text(file),
  });

  const otherServerFiles = await Promise.all(
    serverFiles
      .filter((file) => TEXT.test(file) && !SCRIPT.test(file))
      .map(plain)
  );

  const servedFiles = await Promise.all(
    assets.served
      .filter(({ file }) => !NOT_TEXT.test(file))
      .map(({ file }) => plain(file))
  );

  const scanned: BuiltFile[] = [
    ...workerFiles,
    ...otherServerFiles,
    ...servedFiles.filter(({ code }) => !code.slice(0, 8000).includes("\0")),
  ];

  const secrets = await scanSecrets(
    scanned,
    workerFiles,
    patterns,
    allowed,
    read
  );

  problems.push(...secrets.problems);

  for (const entry of allowed) {
    if (!secrets.used.has(entry)) {
      problems.push({
        kind: "stale-allowed-secret",
        allowed: entry,
        message: `The allowed secret with ${describeAllowed(entry)} (${entry.reason}) matches no finding. Remove it.`,
      });
    }
  }

  const base = {
    serverDir: show(serverDir),
    workerFiles: workerFiles.map((file) => file.path),
    modules: new Set(
      workerFiles.flatMap((file) => [...(file.modules?.keys() ?? [])])
    ).size,
  };

  const counts = {
    servedAssets: assets.served.length,
    ignoredAssets: assets.ignored.length,
    allowedSecrets: secrets.allowedCount,
    problems,
  };

  return assetsDir === undefined
    ? { ...base, ...counts }
    : { ...base, assetsDir: show(assetsDir), ...counts };
};

/**
 * Checks a Worker's build: no forbidden module or marker in the Worker, no source map among the
 * assets Wrangler would serve, and no value shaped like a secret in either. Resolves to the
 * report when it finds nothing; rejects with a {@link WorkerBundleCheckError} that lists the
 * problems otherwise. Run it after the build.
 */
export const checkWorkerBundle = async (
  options: WorkerBundleCheckOptions
): Promise<WorkerBundleReport> => {
  const report = await inspect(options);

  if (report.problems.length) {
    throw new WorkerBundleCheckError(report);
  }

  return report;
};
