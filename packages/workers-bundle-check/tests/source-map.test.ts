import { symlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeMappings,
  modulePath,
  readSourceMap,
  renderedSources,
  sourceAt,
} from "../src/source-map.js";
import { temporaryDirectory, write } from "./helpers.js";

describe("decodeMappings", () => {
  it("decodes each generated line's segments", () => {
    // "AAAA,EAAC;AACA": line 0 has columns 0 and 2 in source 0; line 1 has column 0 in source 0.
    expect(decodeMappings("AAAA,EAAC;AACA")).toEqual([
      [
        [0, 0],
        [2, 0],
      ],
      [[0, 0]],
    ]);
    // Source indexes carry over from line to line: "ACAA" moves to source 1.
    expect(decodeMappings("AAAA;ACAA")).toEqual([[[0, 0]], [[0, 1]]]);
    // A segment of one field maps to no source; an empty line has no segments.
    expect(decodeMappings("A;;gBAAA")).toEqual([[[0, -1]], [], [[16, 0]]]);
  });

  it("refuses a character Base64 lacks", () => {
    expect(() => decodeMappings("AA!A")).toThrow(`The source map's mappings hold "!".`);
  });
});

describe("renderedSources", () => {
  it("counts each source's generated code", () => {
    // `const a=1;` from source 0, `b();` from source 1.
    expect(renderedSources("const a=1;b();", decodeMappings("AAAA,UCAA"))).toEqual(
      new Map([
        [0, 10],
        [1, 4],
      ]),
    );
  });

  it("leaves out what a bundler keeps of a dropped module: the call to its initializer", () => {
    // `init_a(` and `)` from source 0, `,init_b();` from source 1.
    expect([...renderedSources("init_a(),init_b();", decodeMappings("AAAA,OAAA,CCAA"))]).toEqual([
      [1, 10],
    ]);
  });
});

describe("sourceAt", () => {
  it("finds the segment that covers a column", () => {
    const mappings = decodeMappings("AAAA,UCAA;ADAA");
    expect([0, 9, 10, 13].map((column) => sourceAt(mappings, 0, column))).toEqual([0, 0, 1, 1]);
    expect(sourceAt(mappings, 1, 0)).toBe(0);
    expect(sourceAt(mappings, 5, 0)).toBe(-1);
  });
});

describe("readSourceMap", () => {
  const map = { version: 3, sources: ["../src/a.ts"], mappings: "AAAA" };

  it("reads the map the file names, inline or in a file, or else the one beside it", async () => {
    const dir = temporaryDirectory();
    const inline = Buffer.from(JSON.stringify(map)).toString("base64");
    write(dir, {
      "src/a.ts": "",
      "dist/named.js": "a();\n//# sourceMappingURL=maps/named.js.map\n",
      "dist/maps/named.js.map": JSON.stringify({ ...map, sources: ["../../src/a.ts"] }),
      "dist/inline.js": `a();\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${inline}`,
      "dist/hidden.js": "a();",
      "dist/hidden.js.map": JSON.stringify(map),
      "dist/none.js": "a();",
    });
    for (const name of ["named", "inline", "hidden"]) {
      const file = path.join(dir, "dist", `${name}.js`);
      const found = await readSourceMap(file, await readText(file), dir);
      expect(found?.modules, name).toEqual(["src/a.ts"]);
    }
    const none = path.join(dir, "dist/none.js");
    expect(await readSourceMap(none, "a();", dir)).toBeUndefined();
  });

  it("refuses a map it cannot read", async () => {
    const dir = temporaryDirectory();
    write(dir, {
      "index.js.map": JSON.stringify({ version: 3, sections: [] }),
      "broken.js.map": "{",
    });
    await expect(readSourceMap(path.join(dir, "index.js"), "", dir)).rejects.toThrow(
      "index.js.map is an index map (sections), which the check does not read.",
    );
    await expect(readSourceMap(path.join(dir, "broken.js"), "", dir)).rejects.toThrow(
      "broken.js.map is not a source map: it is not JSON.",
    );
  });
});

describe("modulePath", () => {
  it("names a source by its real path, relative to cwd", () => {
    const dir = temporaryDirectory();
    write(dir, {
      "app/src/a.ts": "",
      "node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.js": "",
    });
    symlinkSync("../node_modules/.pnpm/lib@1.0.0/node_modules/lib", path.join(dir, "app/lib"));
    const map = path.join(dir, "app/dist/index.js.map");
    const cwd = path.join(dir, "app");
    expect(modulePath("../src/a.ts", map, undefined, cwd)).toBe("src/a.ts");
    expect(modulePath("../lib/index.js", map, undefined, cwd)).toBe(
      "../node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.js",
    );
    expect(
      modulePath(pathToFileURL(path.join(dir, "app/src/a.ts")).href, map, undefined, cwd),
    ).toBe("src/a.ts");
  });

  it("applies sourceRoot, and looks without it when Wrangler's names no file", () => {
    const dir = temporaryDirectory();
    write(dir, { "src/a.ts": "", "out/src/b.ts": "" });
    const map = path.join(dir, "out/index.js.map");
    expect(modulePath("b.ts", map, "src", dir)).toBe("out/src/b.ts");
    // Wrangler's sources are relative to the map; its sourceRoot is its own output directory.
    expect(modulePath("../src/a.ts", map, "out", dir)).toBe("src/a.ts");
    expect(modulePath("../src/gone.ts", map, "out", dir)).toBe("out/src/gone.ts");
  });

  it("keeps a source that names no file as it is", () => {
    const map = "/project/dist/index.js.map";
    expect(modulePath("\0rolldown/runtime.js", map, undefined, "/project")).toBe(
      "rolldown/runtime.js",
    );
    expect(modulePath("webpack://app/./src/a.ts", map, undefined, "/project")).toBe(
      "webpack://app/./src/a.ts",
    );
  });
});

async function readText(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}
