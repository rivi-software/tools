import path from "node:path";
import { describe, expect, it } from "vitest";
import { assetsIgnoreMatcher, hasInlineSourceMap, readAssets } from "../src/assets.js";
import { temporaryDirectory, wrangler, write } from "./helpers.js";

/** The files of every assets directory below. */
const FILES = [
  "_headers",
  "_redirects",
  "index.html",
  "app.js",
  "app.js.map",
  "app.css.map",
  "assets/a.js",
  "assets/a.js.map",
  "assets/a.css.map",
  "assets/nested/b.js.map",
  "maps/c.js.map",
  "keep.map",
  "src/x.ts",
];

/** `.assetsignore` texts, each a case Wrangler's matching and this package's must agree on. */
const ASSETS_IGNORES: Record<string, string | undefined> = {
  "no .assetsignore": undefined,
  "an empty one": "",
  "*.map": "*.map\n",
  "*.map with CRLF line endings and a comment": "# maps go to the error tracker\r\n*.map\r\n",
  "*.js.map, which keeps CSS maps": "*.js.map\n",
  "a slash anchors to the directory": "/*.map\n",
  "a pattern with a slash matches one directory": "assets/*.map\n",
  "**": "**/*.map\n",
  "a directory": "maps/\nsrc\n",
  negation: "*.map\n!keep.map\n",
  "trailing spaces": "*.map   \n",
  "an escaped leading #": "\\#*\n*.map\n",
};

describe("which assets .assetsignore leaves out", () => {
  it.concurrent.for(Object.entries(ASSETS_IGNORES))(
    "agrees with wrangler deploy for %s",
    { timeout: 30_000 },
    async ([, assetsIgnore]) => {
      const dir = temporaryDirectory();
      write(dir, {
        "index.js": "export default { fetch: () => new Response() };",
        "wrangler.json": JSON.stringify({
          name: "assets-ignore-test",
          main: "index.js",
          compatibility_date: "2026-11-01",
          assets: { directory: "public" },
        }),
        ...Object.fromEntries(FILES.map((file) => [`public/${file}`, file])),
        ...(assetsIgnore === undefined ? {} : { "public/.assetsignore": assetsIgnore }),
      });
      // At debug level, a dry run logs each asset it leaves out of the manifest.
      const output = await wrangler(dir, ["deploy", "--dry-run", "--outdir", "out"], {
        WRANGLER_LOG: "debug",
      });
      const byWrangler = [...output.matchAll(/^Ignoring asset: (.+)$/gm)]
        .map(([, asset]) => asset!.trim().split(path.sep).join("/"))
        .filter((asset) => asset === ".assetsignore" || FILES.includes(asset))
        .sort();
      const { ignored } = await readAssets(path.join(dir, "public"));
      expect(ignored.map(({ asset }) => asset)).toEqual(byWrangler);
    },
  );

  it("leaves out Wrangler's own files, without an .assetsignore too", () => {
    const ignores = assetsIgnoreMatcher(undefined);
    expect(
      ["_headers", "_redirects", ".assetsignore", "app.js.map", "a/_headers"].filter(ignores),
    ).toEqual(["_headers", "_redirects", ".assetsignore"]);
  });
});

describe("an inline source map", () => {
  it("is the comment that ends a script or a style", () => {
    const data = "data:application/json;base64,e30=";
    expect(hasInlineSourceMap(`a();\n//# sourceMappingURL=${data}`)).toBe(true);
    expect(hasInlineSourceMap(`a();\n//# sourceMappingURL=${data}\n\n`)).toBe(true);
    expect(hasInlineSourceMap(`a{}\n/*# sourceMappingURL=${data} */`)).toBe(true);
    expect(hasInlineSourceMap(`a();\n//@ sourceMappingURL=${data}`)).toBe(true);
    // A map in a file of its own, and a string that mentions one.
    expect(hasInlineSourceMap("a();\n//# sourceMappingURL=a.js.map")).toBe(false);
    expect(hasInlineSourceMap('const s = "//# sourceMappingURL=data:";\na(s);')).toBe(false);
  });
});
