import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Plugin, Rollup } from "vite";

/** A file the browser loads lazily (a dynamic import's target), as `modules` sees it. */
export type LazyFile = {
  /**
   * Its path from the project root, with any query: `src/planning/screen.tsx`, or TanStack
   * Router's `src/routes/inbox.tsx?tsr-split=component`.
   */
  id: string;
  /** The files that import it lazily, as paths from the project root. */
  importers: readonly string[];
};

export type DeployWatchOptions = {
  /** The build's id; by default the commit CI builds. Empty turns the watch off. */
  buildId?: string;
  /**
   * Names the module, or modules, a lazily loaded file belongs to; nothing for a file in none.
   * Each named module gets a fingerprint in `build.json`, so a notice can wait until a deploy
   * changes the module its page shows (`useNewBuildNotice({ module })` in `./react`).
   */
  modules?: (file: LazyFile) => string | readonly string[] | null | undefined;
};

/** This package and its entry points, as a server build's `resolve.noExternal` names them. */
export const PACKAGE_PATTERN = /^@rivi-software\/deploy-watch(?:\/|$)/;

/**
 * Where the client output's `build.json` is served, under Vite's `base`: `/app/build.json` for
 * `base: "/app/"`. A relative `base` (`./`) or one on another host cannot be named here, so the
 * tab reads `/build.json` unless the app passes `buildFile` to `startDeployWatch`.
 */
export function buildFileUnder(base: string | undefined): string {
  if (!base?.startsWith("/") || base.startsWith("//")) return "/build.json";
  return `${base.endsWith("/") ? base : `${base}/`}build.json`;
}

/**
 * Gives a build its id for `@rivi-software/deploy-watch`. The server bundles get it (`BuildMeta`
 * writes it into every page) and the browser's assets get `/build.json`, which the open tabs read.
 * The id is the commit CI builds: `WORKERS_CI_COMMIT_SHA` on Cloudflare Workers Builds, GitHub's
 * own `GITHUB_SHA` otherwise. The dev server and a local build have none, so the watch stays off.
 *
 * The browser bundle never holds the id: a commit that changes no browser code renames no chunk,
 * and builds of one commit (one app deployed as several Workers) stay byte for byte the same.
 * `build.json` also carries the browser code's fingerprint, so a tab can tell a deploy that left
 * that code as it was, and with `modules` each module's.
 */
export function deployWatch({
  buildId = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || "",
  modules,
}: DeployWatchOptions = {}): Plugin {
  let id = "";
  let buildFile = "/build.json";
  let root = process.cwd();
  return {
    name: "deploy-watch",
    config(config, { command }) {
      id = command === "build" ? buildId : "";
      buildFile = buildFileUnder(config.base);
    },
    configResolved(config) {
      root = config.root;
    },
    configEnvironment(name) {
      // The browser gets where `build.json` is served, which is the same in every build of the
      // app, so it renames no chunk; never the id.
      if (name === "client")
        return { define: { __DEPLOY_WATCH_BUILD_FILE__: JSON.stringify(buildFile) } };
      // The id reaches `pageBuildId` as a define, and a define only rewrites code the build
      // bundles; a server build leaves a dependency in node_modules external by default.
      return {
        define: { __DEPLOY_WATCH_BUILD_ID__: JSON.stringify(id) },
        resolve: { noExternal: [PACKAGE_PATTERN] },
      };
    },
    generateBundle(_options, bundle = {}) {
      if (!id || this.environment.name !== "client") return;
      const fingerprints = fingerprintBundle(bundle, {
        id,
        root,
        modules,
        importersOf: (module) => this.getModuleInfo?.(module)?.dynamicImporters ?? [],
      });
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: `${JSON.stringify({ id, ...fingerprints })}\n`,
      });
    },
  };
}

type Fingerprints = { client: string; modules?: Record<string, string> };

// A run of the characters an output file's name is made of. Replacing every run that is a file of
// the bundle leaves a file's own content: a chunk whose code did not change keeps its fingerprint,
// although Rollup renames it when a chunk it imports, even lazily, was renamed. A run with the
// build's whole id in it, or that is its short form (a commit's first seven characters), goes too:
// an app may write its release into its browser code for error reports, which changes with every
// commit.
const NAME_RUN = /[\w$.~@+-]+/g;
const SHORT_ID = 7;

function digest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function combine(fingerprints: Iterable<string>): string {
  return digest([...fingerprints].sort().join("\n"));
}

/**
 * The browser code's fingerprint (`client`), from every file but source maps and Vite's own
 * manifests in `.vite/` (which describe the build and are never loaded), and each named
 * module's: the files its lazily loaded entries bring beyond what the page that loads them (the
 * importer's chunk and everything it imports statically) already has.
 */
function fingerprintBundle(
  bundle: Rollup.OutputBundle,
  {
    id,
    root,
    modules,
    importersOf,
  }: {
    id: string;
    root: string;
    modules: DeployWatchOptions["modules"];
    importersOf: (module: string) => readonly string[];
  },
): Fingerprints {
  const outputs = Object.values(bundle).filter(
    (output) =>
      !output.fileName.endsWith(".map") &&
      !output.fileName.startsWith(".vite/") &&
      output.fileName !== "build.json",
  );
  const names = new Set(Object.keys(bundle).map((fileName) => fileName.split("/").pop() ?? ""));
  const short = id.slice(0, SHORT_ID);
  const normalize = (text: string) =>
    text.replace(NAME_RUN, (run) =>
      names.has(run) || run === short || run.includes(id) ? "\0" : run,
    );
  const own = new Map<string, string>();
  for (const output of outputs) {
    const content = output.type === "chunk" ? output.code : output.source;
    own.set(output.fileName, digest(typeof content === "string" ? normalize(content) : content));
  }
  const client = combine(own.values());
  if (!modules) return { client };

  const chunks = new Map<string, Rollup.OutputChunk>();
  const chunkOf = new Map<string, string>();
  for (const output of outputs) {
    if (output.type !== "chunk") continue;
    chunks.set(output.fileName, output);
    for (const module of output.moduleIds) chunkOf.set(module, output.fileName);
  }
  const walk = (
    start: Iterable<string>,
    next: (chunk: Rollup.OutputChunk) => readonly string[],
    skip: ReadonlySet<string> = new Set(),
  ) => {
    const seen = new Set<string>();
    const queue = [...start].filter((file) => !skip.has(file));
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      const chunk = chunks.get(file);
      if (!chunk || seen.has(file)) continue;
      seen.add(file);
      for (const other of next(chunk)) if (!skip.has(other)) queue.push(other);
    }
    return seen;
  };
  const statically = (chunk: Rollup.OutputChunk) => chunk.imports;
  const shell = walk(
    [...chunks.values()].filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName),
    statically,
  );
  // Module ids are real paths, and the root may lie behind a symlink (macOS's /tmp).
  const roots = [root, realPath(root)];
  const fromRoot = (module: string) => {
    if (module.startsWith("\0")) return module;
    const [path = "", query] = module.split("?", 2);
    const local = isAbsolute(path)
      ? (roots
          .map((each) => relative(each, path))
          .find((each) => !each.startsWith("..") && !isAbsolute(each)) ?? path)
      : path;
    const posix = local.split(sep).join("/");
    return query === undefined ? posix : `${posix}?${query}`;
  };

  const files = new Map<string, Set<string>>();
  for (const chunk of chunks.values()) {
    if (!chunk.isDynamicEntry || !chunk.facadeModuleId || shell.has(chunk.fileName)) continue;
    const importers = importersOf(chunk.facadeModuleId);
    const named = modules({
      id: fromRoot(chunk.facadeModuleId),
      importers: importers.map(fromRoot),
    });
    const list = typeof named === "string" ? [named] : (named ?? []);
    if (list.length === 0) continue;
    const loaded = walk(
      [...shell, ...importers.flatMap((module) => chunkOf.get(module) ?? [])],
      statically,
    );
    const code = walk(
      [chunk.fileName],
      (each) => [...each.imports, ...each.dynamicImports],
      loaded,
    );
    for (const name of list) {
      const set = files.get(name) ?? new Set<string>();
      files.set(name, set);
      for (const file of code) {
        set.add(file);
        const meta = chunks.get(file)?.viteMetadata;
        for (const asset of [...(meta?.importedCss ?? []), ...(meta?.importedAssets ?? [])])
          set.add(asset);
      }
    }
  }
  const fingerprints: Record<string, string> = {};
  for (const name of [...files.keys()].sort())
    fingerprints[name] = combine(
      [...(files.get(name) ?? [])].flatMap((file) => own.get(file) ?? []),
    );
  return { client, modules: fingerprints };
}
