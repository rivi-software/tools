import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A version 3 source map, with the fields the check reads. */
export type SourceMap = {
  sources: (string | null)[];
  mappings: string;
  sourceRoot?: string;
  /** An index map's parts. The check reads only plain maps. */
  sections?: unknown;
};

/** A source map with the module path of each of its sources. */
export type ResolvedSourceMap = {
  /** The map file, or the built file itself when the map is inline. */
  file: string;
  map: SourceMap;
  /** Each source's module path, by its index in `map.sources`: see {@link modulePath}. */
  modules: string[];
};

/** A generated position's segment: its column and its source's index, or -1 when it has none. */
export type Segment = [column: number, source: number];

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((char, index) => [char, index]));

/** The segments of each generated line: its column and source index (Base64 VLQ, source map v3). */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let source = 0;
  for (const line of mappings.split(";")) {
    const segments: Segment[] = [];
    let column = 0;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = DIGIT.get(char);
        if (digit === undefined) throw new Error(`The source map's mappings hold "${char}".`);
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value % 2 ? -Math.floor(value / 2) : value / 2);
          value = 0;
          shift = 0;
        }
      }
      column += fields[0] ?? 0;
      if (fields.length >= 4) {
        source += fields[1]!;
        segments.push([column, source]);
      } else segments.push([column, -1]);
    }
    lines.push(segments);
  }
  return lines;
}

/**
 * What Rolldown and esbuild leave of a module whose code was dropped: the call to its lazy
 * initializer, `init_x(` and the `)` that closes it, kept where its importer was.
 */
const INIT_RESIDUE = /^(?:[\w$]+\(|\)[\s,;)}\]]*)$/;

/**
 * The bytes of generated code each source renders, by source index. A source whose only code is
 * the residue of a dropped module is left out.
 */
export function renderedSources(code: string, mappings: Segment[][]): Map<number, number> {
  const sizes = new Map<number, number>();
  const lines = code.split("\n");
  mappings.forEach((segments, line) => {
    const text = lines[line] ?? "";
    segments.forEach(([column, source], position) => {
      if (source < 0) return;
      const end = segments[position + 1]?.[0] ?? text.length;
      const rendered = text.slice(column, end).trim();
      if (!rendered || INIT_RESIDUE.test(rendered)) return;
      sizes.set(source, (sizes.get(source) ?? 0) + rendered.length);
    });
  });
  return sizes;
}

/** The source index of the code at a generated line (0-based) and column, or -1. */
export function sourceAt(mappings: Segment[][], line: number, column: number): number {
  let found = -1;
  for (const [start, source] of mappings[line] ?? []) {
    if (start > column) break;
    found = source;
  }
  return found;
}

/** The `sourceMappingURL` comment at the end of a built file. */
const SOURCE_MAPPING_URL = /\/[/*][#@] sourceMappingURL=([^\s'"*]+)[\s*/]*$/;

/**
 * The source map of a built file: the one its `sourceMappingURL` names, inline or in a file, or
 * else `<file>.map` beside it, which is where a `hidden` map is. Undefined when it has none.
 */
export async function readSourceMap(
  file: string,
  code: string,
  cwd: string,
): Promise<ResolvedSourceMap | undefined> {
  // From the last comment, not the file's last few kB: an inline map can be megabytes long.
  const at = code.lastIndexOf("sourceMappingURL=");
  const url = at < 4 ? undefined : SOURCE_MAPPING_URL.exec(code.slice(at - 4))?.[1];
  let found: { file: string; text: string } | undefined;
  if (url?.startsWith("data:")) {
    const comma = url.indexOf(",");
    const data = url.slice(comma + 1);
    found = {
      file,
      text: /;base64$/.test(url.slice(0, comma))
        ? Buffer.from(data, "base64").toString("utf8")
        : decodeURIComponent(data),
    };
  } else {
    const candidates = [`${file}.map`];
    if (url && !/^[a-z][a-z\d+.-]*:/i.test(url))
      candidates.unshift(path.resolve(path.dirname(file), decodeURIComponent(url)));
    const mapFile = candidates.find((candidate) => existsSync(candidate));
    if (mapFile) found = { file: mapFile, text: await readFile(mapFile, "utf8") };
  }
  if (!found) return undefined;

  let map: SourceMap;
  try {
    map = JSON.parse(found.text) as SourceMap;
  } catch {
    throw new Error(`${display(found.file, cwd)} is not a source map: it is not JSON.`);
  }
  if (map.sections)
    throw new Error(
      `${display(found.file, cwd)} is an index map (sections), which the check does not read.`,
    );
  if (!Array.isArray(map.sources) || typeof map.mappings !== "string")
    throw new Error(
      `${display(found.file, cwd)} is not a source map: it lacks sources or mappings.`,
    );
  return {
    file: found.file,
    map,
    modules: map.sources.map((source) => modulePath(source ?? "", found.file, map.sourceRoot, cwd)),
  };
}

/**
 * The module a source map's source names, as a path relative to `cwd` with `/` between segments,
 * symlinks resolved: `src/server.ts`, `node_modules/.pnpm/msw@2.7.0/node_modules/msw/lib/core/index.mjs`,
 * or `../../node_modules/…` for a module outside `cwd`. A source that names no file, such as a
 * bundler's virtual module, is kept as it is.
 *
 * The source is resolved from the map's directory and `sourceRoot`, as the specification says.
 * Wrangler writes a `sourceRoot` that its own sources do not use, so when no file is there, the
 * source is looked for without it.
 */
export function modulePath(
  source: string,
  mapFile: string,
  sourceRoot: string | undefined,
  cwd: string,
): string {
  if (source.startsWith("file:")) return display(fileURLToPath(source), cwd);
  if (!source || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("\0"))
    return source.replace(/^\0/, "");
  const base = path.dirname(mapFile);
  const candidates = [path.resolve(base, sourceRoot ?? "", source)];
  if (sourceRoot) candidates.push(path.resolve(base, source));
  return display(candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!, cwd);
}

/** The real path of a file, or undefined when it does not exist. */
export function realPath(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

/**
 * A path as reports show it: relative to `cwd`, which is a real path, with `/` between segments.
 * A file that exists is named by its real path.
 */
export function display(file: string, cwd: string): string {
  return posixRelative(cwd, realPath(file) ?? file);
}

/** `file` relative to `dir`, with `/` between segments. */
export function posixRelative(dir: string, file: string): string {
  return (path.relative(dir, file) || ".").split(path.sep).join("/");
}
