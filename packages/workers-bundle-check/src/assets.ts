import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import ignore from "ignore";

import { AFTER_SOURCE_MAPPING_URL, posixRelative } from "./source-map.js";

/** A file in the assets directory. */
export interface AssetFile {
  /** Its path in the assets directory, with `/` between segments: the one `.assetsignore` matches. */
  asset: string;
  /** Its absolute path. */
  file: string;
}

/** The assets directory's files, split into those Wrangler uploads and those it leaves out. */
export interface Assets {
  served: AssetFile[];
  ignored: AssetFile[];
}

/**
 * Whether Wrangler leaves an asset out of the upload, for the `.assetsignore` text (undefined
 * when there is none). Wrangler matches each path in the directory with the `ignore` package
 * (gitignore syntax), against the file's lines and its own patterns for `.assetsignore`,
 * `_redirects` and `_headers` (workers-sdk, packages/workers-shared/utils/helpers.ts,
 * `createAssetsIgnoreFunction`). This builds the same matcher.
 */
export const assetsIgnoreMatcher = (
  assetsIgnore: string | undefined
): ((asset: string) => boolean) => {
  const patterns = ["/.assetsignore", "/_redirects", "/_headers"];

  if (assetsIgnore !== undefined) {
    patterns.push(...assetsIgnore.split("\n"));
  }

  const matcher = ignore.default().add(patterns);

  return (asset) => matcher.ignores(asset);
};

/** The order `readAssets` lists each of its two groups in: by asset path. */
const byAsset = (a: AssetFile, b: AssetFile): number => {
  if (a.asset < b.asset) {
    return -1;
  }

  return a.asset > b.asset ? 1 : 0;
};

/**
 * The codes `stat` fails with for a link that points to nothing: its target is missing
 * (`ENOENT`), goes through a file (`ENOTDIR`), or is a loop of links (`ELOOP`).
 */
const NO_TARGET = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/**
 * Whether `file` is a file, or a link to one: `stat` follows links. A link that points to
 * nothing is not a file.
 */
export const isFile = async (file: string): Promise<boolean> => {
  const stats = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== undefined && NO_TARGET.has(error.code)) {
      return;
    }

    throw error;
  });

  return stats?.isFile() ?? false;
};

/**
 * The files of the assets directory, as Wrangler's upload sees them. Wrangler's
 * `buildAssetManifest` lists the directory with `readdir`, which follows a link to a directory,
 * and uploads each path that `stat` finds to be a file, so a link to a file is served as that file.
 */
export const readAssets = async (dir: string): Promise<Assets> => {
  // Without `withFileTypes`, `readdir` follows links to directories on every Node version, as
  // Wrangler's call does; with it, Node 26 follows them and Node 22 and 24 do not.
  const entries = await readdir(dir, { recursive: true });

  const assetsIgnore = await readFile(
    path.join(dir, ".assetsignore"),
    "utf-8"
  ).catch((error: NodeJS.ErrnoException): string | undefined => {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  });

  const ignored = assetsIgnoreMatcher(assetsIgnore);
  const assets: Assets = { served: [], ignored: [] };

  const files = entries.map((entry) => path.join(dir, entry));
  const areFiles = await Promise.all(files.map(isFile));

  for (const [index, file] of files.entries()) {
    if (!areFiles[index]) {
      continue;
    }

    const asset: AssetFile = { asset: posixRelative(dir, file), file };
    (ignored(asset.asset) ? assets.ignored : assets.served).push(asset);
  }

  assets.served.sort(byAsset);
  assets.ignored.sort(byAsset);

  return assets;
};

/** A source map the assets would serve. */
export interface ServedSourceMap {
  kind: "served-source-map" | "inline-source-map";
  /** The asset's absolute path. */
  file: string;
}

/** Scripts and styles, which can carry a source map inline. */
const SCRIPT_OR_STYLE = /\.(?:[cm]?js|css)$/iu;

/** A `.map` file, which the assets would serve as the source map it is. */
const MAP_FILE = /\.map$/iu;

/**
 * The `sourceMappingURL` comment that holds the map itself, which only whitespace and comments
 * follow.
 */
const INLINE_SOURCE_MAP = new RegExp(
  String.raw`^\/[/*][#@] sourceMappingURL=data:[^\s*]*${AFTER_SOURCE_MAPPING_URL}`,
  "u"
);

/** Whether a script or style carries its source map inline. */
export const hasInlineSourceMap = (code: string): boolean => {
  const at = code.lastIndexOf("sourceMappingURL=data:");

  return at >= 4 && INLINE_SOURCE_MAP.test(code.slice(at - 4));
};

/**
 * The source maps among the served assets: a `.map` file, or a script or style that carries its
 * map inline. `text` reads a served script or style.
 */
export const findServedSourceMaps = async (
  served: readonly AssetFile[],
  text: (file: string) => Promise<string>
): Promise<ServedSourceMap[]> => {
  const found: ServedSourceMap[] = [];

  for (const { asset, file } of served) {
    if (MAP_FILE.test(asset)) {
      found.push({ kind: "served-source-map", file });
      continue;
    }

    if (!SCRIPT_OR_STYLE.test(asset)) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- one asset is read at a time on purpose: the assets directory can hold thousands of files
    const code = await text(file);

    if (hasInlineSourceMap(code)) {
      found.push({ kind: "inline-source-map", file });
    }
  }

  return found;
};
