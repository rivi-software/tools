import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { posixRelative } from "./source-map.js";

/** A file in the assets directory. */
export type AssetFile = {
  /** Its path in the assets directory, with `/` between segments: the one `.assetsignore` matches. */
  asset: string;
  /** Its absolute path. */
  file: string;
};

/** The assets directory's files, split into those Wrangler uploads and those it leaves out. */
export type Assets = { served: AssetFile[]; ignored: AssetFile[] };

/**
 * Whether Wrangler leaves an asset out of the upload, for the `.assetsignore` text (undefined
 * when there is none). Wrangler matches each path in the directory with the `ignore` package
 * (gitignore syntax), against the file's lines and its own patterns for `.assetsignore`,
 * `_redirects` and `_headers` (workers-sdk, packages/workers-shared/utils/helpers.ts,
 * `createAssetsIgnoreFunction`). This builds the same matcher.
 */
export function assetsIgnoreMatcher(assetsIgnore: string | undefined): (asset: string) => boolean {
  const patterns = ["/.assetsignore", "/_redirects", "/_headers"];
  if (assetsIgnore !== undefined) patterns.push(...assetsIgnore.split("\n"));
  const matcher = ignore.default().add(patterns);
  return (asset) => matcher.ignores(asset);
}

/** The files of the assets directory, as Wrangler's upload sees them. */
export async function readAssets(dir: string): Promise<Assets> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const assetsIgnore = await readFile(path.join(dir, ".assetsignore"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  const ignored = assetsIgnoreMatcher(assetsIgnore);
  const assets: Assets = { served: [], ignored: [] };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const asset: AssetFile = { asset: posixRelative(dir, file), file };
    (ignored(asset.asset) ? assets.ignored : assets.served).push(asset);
  }
  const order = (a: AssetFile, b: AssetFile) =>
    a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0;
  assets.served.sort(order);
  assets.ignored.sort(order);
  return assets;
}

/** A source map the assets would serve. */
export type ServedSourceMap = {
  kind: "served-source-map" | "inline-source-map";
  /** The asset's absolute path. */
  file: string;
};

/** Scripts and styles, which can carry a source map inline. */
const SCRIPT_OR_STYLE = /\.(?:[cm]?js|css)$/i;

/** The `sourceMappingURL` comment that ends a file and holds the map itself. */
const INLINE_SOURCE_MAP = /^\/[/*][#@] sourceMappingURL=data:[^\s*]*[\s*/]*$/;

/** Whether a script or style ends with its source map inline. */
export function hasInlineSourceMap(code: string): boolean {
  const at = code.lastIndexOf("sourceMappingURL=data:");
  return at >= 4 && INLINE_SOURCE_MAP.test(code.slice(at - 4));
}

/**
 * The source maps among the served assets: a `.map` file, or a script or style that carries its
 * map inline. `text` reads a served script or style.
 */
export async function findServedSourceMaps(
  served: readonly AssetFile[],
  text: (file: string) => Promise<string>,
): Promise<ServedSourceMap[]> {
  const found: ServedSourceMap[] = [];
  for (const { asset, file } of served) {
    if (/\.map$/i.test(asset)) found.push({ kind: "served-source-map", file });
    else if (SCRIPT_OR_STYLE.test(asset) && hasInlineSourceMap(await text(file)))
      found.push({ kind: "inline-source-map", file });
  }
  return found;
}
