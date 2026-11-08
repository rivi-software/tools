import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import type { Plugin, Rollup } from "vite";

import { ownBuildFilePath } from "./own-build-file.js";

/** A file the browser loads lazily (a dynamic import's target), as `modules` sees it. */
export interface LazyFile {
  /**
   * Its path from the project root, with any query: `src/planning/screen.tsx`, or TanStack
   * Router's `src/routes/inbox.tsx?tsr-split=component`.
   */
  id: string;
  /** The files that import it lazily, as paths from the project root. */
  importers: readonly string[];
}

export interface DeployWatchOptions {
  /**
   * The build's id; by default the commit CI builds, from `WORKERS_CI_COMMIT_SHA`,
   * `CF_PAGES_COMMIT_SHA`, `GITHUB_SHA` or `CI_COMMIT_SHA`. Empty turns the watch off.
   */
  buildId?: string;
  /**
   * Names the module, or modules, a lazily loaded file belongs to; nothing for a file in none.
   * Each named module gets a fingerprint in `build.json`, so a notice can wait until a deploy
   * changes the module its page shows (`useNewBuildNotice({ module })` in `./react`).
   */
  modules?: (file: LazyFile) => string | readonly string[] | null | undefined;
}

/** What `modules` answers for one lazily loaded file. */
type ModuleNames = string | readonly string[] | null | undefined;

/** This package and its entry points, as a server build's `resolve.noExternal` names them. */
export const PACKAGE_PATTERN = /^@rivi-software\/deploy-watch(?:\/|$)/u;

/**
 * Where the client output's `build.json` is served, under Vite's `base`: `/app/build.json` for
 * `base: "/app/"`. A relative `base` (`./`) or one on another host cannot be named here, so the
 * tab reads `/build.json` unless the app passes `buildFile` to `startDeployWatch`.
 */
export const buildFileUnder = (base: string | undefined): string => {
  if (!base?.startsWith("/") || base.startsWith("//")) {
    return "/build.json";
  }

  return `${base.endsWith("/") ? base : `${base}/`}build.json`;
};

// Where CI services put the commit they build, read in this order: Cloudflare Workers Builds,
// Cloudflare Pages, GitHub Actions, then GitLab CI and the services that share its name for it.
const COMMIT_VARIABLES = [
  "WORKERS_CI_COMMIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "GITHUB_SHA",
  "CI_COMMIT_SHA",
] as const;

const commitFromEnvironment = (): string => {
  for (const name of COMMIT_VARIABLES) {
    const value = process.env[name];

    if (value) {
      return value;
    }
  }

  return "";
};

const isCI = (): boolean => {
  const ci = process.env.CI;

  return !!ci && ci !== "false" && ci !== "0";
};

const NO_BUILD_ID =
  "[deploy-watch] This build has no id, so the watch is off: tabs open on the previous deploy " +
  `will not move onto it. None of ${COMMIT_VARIABLES.join(", ")} is set; pass the id as ` +
  '`deployWatch({ buildId })`, or `buildId: ""` to keep the watch off without this warning.';

// A framework may resolve its Vite config, and so run these hooks, once per build it runs.
let warnedNoBuildId = false;

interface Fingerprints {
  client: string;
  modules?: Record<string, string>;
}

// A run of the characters an output file's name is made of. For a module's fingerprint, replacing
// every run that is a file of the bundle leaves a file's own content: a chunk whose code did not
// change keeps its fingerprint, although Rollup renames it when a chunk it imports, even lazily,
// was renamed. A run with the build's whole id in it, or that is its short form (a commit's first
// seven characters), goes too: an app may write its release into its browser code for error
// reports, which changes with every commit. An id shorter than that (a CI build number) stays, so
// that runs which merely contain it do not hide a change.
const NAME_RUN = /[\w$.~@+-]+/gu;
const SHORT_ID = 7;

const digest = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 16);

const realPath = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

const combine = (fingerprints: Iterable<string>): string =>
  digest([...fingerprints].toSorted().join("\n"));

/** Whether an output's content is code or text, rather than bytes. */
const isTextContent = (content: string | Uint8Array): content is string =>
  typeof content === "string";

/** Whether `modules` named one module rather than a list of them. */
const isOneName = (named: ModuleNames): named is string =>
  typeof named === "string";

/** The files a chunk imports in the page that loads it, without waiting for a dynamic import. */
const statically = (chunk: Rollup.OutputChunk) => chunk.imports;

/**
 * The chunks reachable from `start` by following `edges`, `start` itself included and the chunks
 * in `skip`, with everything only they reach, left out.
 */
const walk = (
  chunks: ReadonlyMap<string, Rollup.OutputChunk>,
  start: Iterable<string>,
  edges: (chunk: Rollup.OutputChunk) => readonly string[],
  skip: ReadonlySet<string> = new Set()
): ReadonlySet<string> => {
  const seen = new Set<string>();
  const queue = [...start].filter((file) => !skip.has(file));

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const chunk = chunks.get(file);

    if (!chunk || seen.has(file)) {
      continue;
    }

    seen.add(file);

    for (const other of edges(chunk)) {
      if (!skip.has(other)) {
        queue.push(other);
      }
    }
  }

  return seen;
};

/** Each file in `code`, with the styles and assets its chunk brings with it. */
const filesOf = (
  chunks: ReadonlyMap<string, Rollup.OutputChunk>,
  code: Iterable<string>
): string[] => {
  const files: string[] = [];

  for (const file of code) {
    const meta = chunks.get(file)?.viteMetadata;

    files.push(
      file,
      ...(meta?.importedCss ?? []),
      ...(meta?.importedAssets ?? [])
    );
  }

  return files;
};

interface ModuleFilesInput {
  chunks: ReadonlyMap<string, Rollup.OutputChunk>;
  /** The chunk each module of the bundle ended up in. */
  chunkOf: ReadonlyMap<string, string>;
  /** The chunks every page already has: the entries and everything they import statically. */
  shell: ReadonlySet<string>;
  importersOf: (module: string) => readonly string[];
  modules: NonNullable<DeployWatchOptions["modules"]>;
  /** A module id as a path from the project root. */
  fromRoot: (module: string) => string;
}

/**
 * The files each named module brings beyond what the page that loads it already has: its lazily
 * loaded entry's chunks, their dynamic imports, and the styles and assets those bring.
 */
const moduleFiles = ({
  chunks,
  chunkOf,
  shell,
  importersOf,
  modules,
  fromRoot,
}: ModuleFilesInput): Map<string, Set<string>> => {
  const files = new Map<string, Set<string>>();

  for (const chunk of chunks.values()) {
    if (
      !chunk.isDynamicEntry ||
      !chunk.facadeModuleId ||
      shell.has(chunk.fileName)
    ) {
      continue;
    }

    const importers = importersOf(chunk.facadeModuleId);

    const named = modules({
      id: fromRoot(chunk.facadeModuleId),
      importers: importers.map(fromRoot),
    });

    const list = isOneName(named) ? [named] : (named ?? []);

    if (list.length === 0) {
      continue;
    }

    const loaded = walk(
      chunks,
      [...shell, ...importers.flatMap((module) => chunkOf.get(module) ?? [])],
      statically
    );

    const code = walk(
      chunks,
      [chunk.fileName],
      (each) => [...each.imports, ...each.dynamicImports],
      loaded
    );

    for (const name of list) {
      const set = files.get(name) ?? new Set<string>();
      files.set(name, set);

      for (const file of filesOf(chunks, code)) {
        set.add(file);
      }
    }
  }

  return files;
};

/**
 * The browser code's fingerprint (`client`), from the name and the exact content of every file
 * but source maps, Vite's own manifests in `.vite/` (which describe the build and are never
 * loaded) and the build's files this plugin writes. It changes whenever a file the tab could load
 * is renamed or changed, since a tab on the old build may need files the new one no longer serves.
 *
 * Each named module's fingerprint only decides whether a notice shows, so it reads what the code
 * does: the files its lazily loaded entries bring beyond what the page that loads them (the
 * importer's chunk and everything it imports statically) already has, without file names or the
 * build's id.
 */
const fingerprintBundle = (
  bundle: Rollup.OutputBundle,
  {
    id,
    root,
    modules,
    importersOf,
    buildFiles,
  }: {
    id: string;
    root: string;
    modules: DeployWatchOptions["modules"];
    importersOf: (module: string) => readonly string[];
    buildFiles: ReadonlySet<string>;
  }
): Fingerprints => {
  const outputs = Object.values(bundle).filter(
    (output) =>
      !output.fileName.endsWith(".map") &&
      !output.fileName.startsWith(".vite/") &&
      !buildFiles.has(output.fileName)
  );

  const client = combine(
    outputs.map(
      (output) =>
        `${output.fileName}\0${digest(output.type === "chunk" ? output.code : output.source)}`
    )
  );

  if (!modules) {
    return { client };
  }

  const names = new Set(
    Object.keys(bundle).map((fileName) => fileName.split("/").pop() ?? "")
  );

  const short = id.length >= SHORT_ID ? id.slice(0, SHORT_ID) : null;

  const isId = (run: string) =>
    short !== null && (run === short || run.includes(id));

  const normalize = (text: string) =>
    text.replaceAll(NAME_RUN, (run) =>
      names.has(run) || isId(run) ? "\0" : run
    );

  const own = new Map<string, string>();

  for (const output of outputs) {
    const content = output.type === "chunk" ? output.code : output.source;
    own.set(
      output.fileName,
      digest(isTextContent(content) ? normalize(content) : content)
    );
  }

  const chunks = new Map<string, Rollup.OutputChunk>();
  const chunkOf = new Map<string, string>();

  for (const output of outputs) {
    if (output.type !== "chunk") {
      continue;
    }

    chunks.set(output.fileName, output);

    for (const module of output.moduleIds) {
      chunkOf.set(module, output.fileName);
    }
  }

  const shell = walk(
    chunks,
    [...chunks.values()].flatMap((chunk) =>
      chunk.isEntry ? [chunk.fileName] : []
    ),
    statically
  );

  // Module ids are real paths, and the root may lie behind a symlink (macOS's /tmp).
  const roots = [root, realPath(root)];

  const fromRoot = (module: string) => {
    if (module.startsWith("\0")) {
      return module;
    }

    const [file = "", query] = module.split("?", 2);

    const local = path.isAbsolute(file)
      ? (roots
          .map((each) => path.relative(each, file))
          .find((each) => !each.startsWith("..") && !path.isAbsolute(each)) ??
        file)
      : file;

    const posix = local.split(path.sep).join("/");

    return query === undefined ? posix : `${posix}?${query}`;
  };

  const files = moduleFiles({
    chunks,
    chunkOf,
    shell,
    importersOf,
    modules,
    fromRoot,
  });

  const fingerprints: Record<string, string> = {};

  for (const name of [...files.keys()].toSorted()) {
    fingerprints[name] = combine(
      [...(files.get(name) ?? [])].flatMap((file) => own.get(file) ?? [])
    );
  }

  return { client, modules: fingerprints };
};

/**
 * Gives a build its id for `@rivi-software/deploy-watch`. The server bundles get it (`BuildMeta`
 * writes it into every page) and the browser's assets get `/build.json`, which the open tabs read,
 * and a copy under the build's own name in the assets directory (`assets/deploy-watch-<id>.json`),
 * which a tab reads once a deploy has replaced its build.
 * The id is the commit CI builds: `WORKERS_CI_COMMIT_SHA` on Cloudflare Workers Builds,
 * `CF_PAGES_COMMIT_SHA` on Cloudflare Pages, `GITHUB_SHA` on GitHub Actions, and `CI_COMMIT_SHA` on
 * GitLab CI and the services that share its name, read in that order. The dev server
 * and a local build have none, so the watch stays off; a production build in CI (`CI` set) that
 * finds none warns once, unless the app passed `buildId`.
 *
 * The browser bundle never holds the id: a commit that changes no browser code renames no chunk,
 * and builds of one commit (one app deployed as several Workers) stay byte for byte the same.
 * `build.json` also carries the browser code's fingerprint, so a tab can tell a deploy that left
 * that code as it was, and with `modules` each module's.
 */
export const deployWatch = ({
  buildId,
  modules,
}: DeployWatchOptions = {}): Plugin => {
  const buildIdOrCommit = buildId ?? commitFromEnvironment();
  let id = "";
  let buildFile = "/build.json";
  let assetsDir = "assets";
  let root = process.cwd();

  return {
    name: "deploy-watch",
    config(config, { command }) {
      id = command === "build" ? buildIdOrCommit : "";
      buildFile = buildFileUnder(config.base);
    },
    configResolved(config) {
      ({ root } = config);

      if (
        !buildIdOrCommit &&
        buildId === undefined &&
        config.command === "build" &&
        config.isProduction &&
        isCI() &&
        !warnedNoBuildId
      ) {
        warnedNoBuildId = true;
        config.logger.warn(NO_BUILD_ID);
      }
    },
    configEnvironment(name, config) {
      // The browser gets where `build.json` and the assets are served, which is the same in every
      // build of the app, so it renames no chunk; never the id.
      if (name === "client") {
        assetsDir = config.build?.assetsDir ?? "assets";

        return {
          define: {
            __DEPLOY_WATCH_BUILD_FILE__: JSON.stringify(buildFile),
            __DEPLOY_WATCH_ASSETS_DIR__: JSON.stringify(assetsDir),
          },
        };
      }

      // The id reaches `pageBuildId` as a define, and a define only rewrites code the build
      // bundles; a server build leaves a dependency in node_modules external by default.
      return {
        define: { __DEPLOY_WATCH_BUILD_ID__: JSON.stringify(id) },
        resolve: { noExternal: [PACKAGE_PATTERN] },
      };
    },
    generateBundle(_options, bundle = {}) {
      if (!id || this.environment.name !== "client") {
        return;
      }

      const ownFile = ownBuildFilePath(assetsDir, id);

      const fingerprints = fingerprintBundle(bundle, {
        id,
        root,
        modules,
        importersOf: (module) =>
          this.getModuleInfo?.(module)?.dynamicImporters ?? [],
        buildFiles: new Set(["build.json", ...(ownFile ? [ownFile] : [])]),
      });

      const source = `${JSON.stringify({ id, ...fingerprints })}\n`;
      this.emitFile({ type: "asset", fileName: "build.json", source });

      if (ownFile) {
        this.emitFile({ type: "asset", fileName: ownFile, source });
      }
    },
  };
};
