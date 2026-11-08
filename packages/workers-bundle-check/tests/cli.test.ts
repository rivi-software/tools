import { describe, expect, it } from "vitest";

import { runCli, USAGE } from "../src/run-cli.js";
import { temporaryDirectory, write } from "./helpers.js";

const run = async (cwd: string, args: string[]) => {
  const log: string[] = [];
  const error: string[] = [];

  const code = await runCli(args, {
    cwd,
    log: (line) => log.push(line),
    error: (line) => error.push(line),
  });

  return { code, log: log.join("\n"), error: error.join("\n") };
};

const WORKER = 'export default { fetch: () => new Response("ok") };';

/**
 * A built Worker whose source map maps its one line to `src/index.ts`, assets that leave their
 * maps out, and no configuration.
 */
const built = (): string => {
  const dir = temporaryDirectory();
  write(dir, {
    "src/index.ts": "",
    "dist/server/index.js": WORKER,
    "dist/server/index.js.map": JSON.stringify({
      version: 3,
      sources: ["../../src/index.ts"],
      mappings: "AAAA",
    }),
    "dist/client/.assetsignore": "*.map\n",
    "dist/client/app.js": "app()",
    "dist/client/app.js.map": "{}",
  });

  return dir;
};

describe("workers-bundle-check", () => {
  it("checks the directories its flags name", async () => {
    await expect(
      run(built(), ["--server", "dist/server", "--assets", "dist/client"])
    ).resolves.toStrictEqual({
      code: 0,
      log: [
        "dist/server: 1 file and 1 module, none that 0 forbidden rules name.",
        "dist/client: 1 file served and 2 left out, no source map among them.",
        "No value shaped like a secret.",
      ].join("\n"),
      error: "",
    });
  });

  it("reads the options from a configuration module, with regular expressions", async () => {
    const dir = built();
    write(dir, {
      "workers-bundle-check.config.mjs": `export default {
        serverDir: "dist/server",
        assetsDir: "dist/client",
        forbidden: [{ marker: /new Response\\("\\w+"\\)/, reason: "no fixed bodies" }],
      };`,
    });
    const result = await run(dir, []);
    expect(result).toStrictEqual({
      code: 1,
      log: "",
      error: [
        "The Worker bundle check found 1 problem:",
        '  dist/server/index.js contains the marker /new Response\\("\\w+"\\)/, which is forbidden: no fixed bodies.',
      ].join("\n"),
    });
  });

  it("reads a TypeScript configuration, and lets the flags override it", async () => {
    const dir = built();
    write(dir, {
      "dist/other/index.js":
        "export default {};\n//# sourceMappingURL=index.js.map",
      "dist/other/index.js.map": JSON.stringify({
        version: 3,
        sources: [],
        mappings: "",
      }),
      "workers-bundle-check.config.ts": `type Options = { serverDir: string };
        export default { serverDir: "dist/missing" } satisfies Options;`,
    });
    const missing = await run(dir, []);
    expect(missing.error).toBe(
      "There is no Worker build at dist/missing: run the build first."
    );

    const other = await run(dir, ["--server", "dist/other"]);
    expect(other.log).toBe(
      [
        "dist/other: 1 file and 0 modules, none that 0 forbidden rules name.",
        "No value shaped like a secret.",
      ].join("\n")
    );
  });

  it("reads JSON from the file --config names", async () => {
    const dir = built();
    write(dir, {
      "checks/bundle.json": JSON.stringify({
        serverDir: "dist/server",
        forbidden: [{ module: "src/**", reason: "nothing of ours" }],
      }),
    });
    await expect(
      run(dir, ["--config", "checks/bundle.json"])
    ).resolves.toStrictEqual({
      code: 1,
      log: "",
      error: [
        "The Worker bundle check found 1 problem:",
        `  dist/server/index.js holds src/index.ts (${WORKER.length} B), which "src/**" forbids: nothing of ours.`,
      ].join("\n"),
    });
  });

  it("says what it needs", async () => {
    const dir = temporaryDirectory();
    await expect(run(dir, [])).resolves.toStrictEqual({
      code: 2,
      log: "",
      error: `Name the Worker's build output: --server <dir>, or serverDir in workers-bundle-check.config.ts.\n\n${USAGE}`,
    });
    await expect(run(dir, ["--config", "nope.mjs"])).resolves.toStrictEqual({
      code: 2,
      log: "",
      error: "There is no configuration file at nope.mjs.",
    });
    const unknownFlag = await run(dir, ["--serve", "dist"]);
    expect(unknownFlag.code).toBe(2);
    await expect(run(dir, ["--help"])).resolves.toStrictEqual({
      code: 0,
      log: USAGE,
      error: "",
    });
    write(dir, { "workers-bundle-check.config.json": "[]" });
    const notOptions = await run(dir, []);
    expect(notOptions.error).toMatch(
      /workers-bundle-check\.config\.json must export the options as its default export: \{ serverDir, … \}\.$/u
    );
  });
});
