import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ignore from "ignore";

import { posixRelative } from "./source-map.js";

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

/** The files of the assets directory, as Wrangler's upload sees them. */
export const readAssets = async (dir: string): Promise<Assets> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

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

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const file = path.join(entry.parentPath, entry.name);
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

/** The `sourceMappingURL` comment that ends a file and holds the map itself. */
const INLINE_SOURCE_MAP = /^\/[/*][#@] sourceMappingURL=data:[^\s*]*[\s*/]*$/u;

/** Whether a script or style ends with its source map inline. */
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
