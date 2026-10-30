import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { zodJitless } from "../src/index.js";
import { APP, build, manifest, project, runWithoutCodegen, wrappers } from "./support/fixture.js";

// Each test builds a project with Vite and runs the bundle in a fresh Node process that refuses to
// compile strings, as a strict Content-Security-Policy does, and counts every attempt.
describe("the build", { timeout: 30_000 }, () => {
  test("never compiles a string with the plugin, and the schemas still validate", async () => {
    const root = project(APP);
    const { modules, warnings } = await build(root, [zodJitless()]);

    expect(wrappers(modules, root)).toEqual(["zod zod/index.js"]);
    expect(warnings).toEqual([]);
    expect(await runWithoutCodegen(join(root, "dist/main.js"))).toEqual({
      attempts: [],
      result: { valid: true, invalid: false },
    });
  });

  test("keeps the call when the build assumes modules have no side effects", async () => {
    const root = project(APP);
    await build(root, [zodJitless()], { treeshake: { moduleSideEffects: false } });

    expect(await runWithoutCodegen(join(root, "dist/main.js"))).toEqual({
      attempts: [],
      result: { valid: true, invalid: false },
    });
  });

  test("probes `new Function` without the plugin", async () => {
    const root = project(APP);
    await build(root, []);

    expect(await runWithoutCodegen(join(root, "dist/main.js"))).toEqual({
      attempts: ["Function"],
      result: { valid: true, invalid: false },
    });
  });

  test("probes even when the entry sets jitless first thing, since a dependency ran before it", async () => {
    const root = project({
      ...APP,
      "src/main.js": `
        import { Address } from "acme-forms";
        import { z } from "zod";

        z.config({ jitless: true });
        globalThis.result = Address.safeParse({ city: "Springfield" }).success;
      `,
    });
    await build(root, []);

    expect(await runWithoutCodegen(join(root, "dist/main.js"))).toEqual({
      attempts: ["Function"],
      result: true,
    });
  });

  test("wraps each Zod 4 entry point, default export included, and leaves zod/v3 alone", async () => {
    const root = project({
      "src/main.js": `
        import zod from "zod";
        import * as v4 from "zod/v4";
        import * as mini from "zod/mini";
        import * as v4Mini from "zod/v4-mini";
        import { object, string } from "zod/v4/mini";
        import * as core from "zod/v4/core";
        import { z as v3 } from "zod/v3";

        const input = { name: "Acme" };
        globalThis.result = [
          zod.object({ name: zod.string() }).safeParse(input).success,
          v4.object({ name: v4.string() }).safeParse(input).success,
          mini.safeParse(mini.object({ name: mini.string() }), input).success,
          v4Mini.safeParse(v4Mini.object({ name: v4Mini.string() }), input).success,
          core.safeParse(object({ name: string() }), input).success,
          v3.object({ name: v3.string() }).safeParse(input).success,
        ];
      `,
    });
    const { modules, warnings } = await build(root, [zodJitless()]);

    expect(wrappers(modules, root)).toEqual([
      "zod zod/index.js",
      "zod/mini zod/mini/index.js",
      "zod/v4 zod/v4/index.js",
      "zod/v4-mini zod/v4-mini/index.js",
      "zod/v4/core zod/v4/core/index.js",
      "zod/v4/mini zod/v4/mini/index.js",
    ]);
    expect(warnings).toEqual([]);
    expect(await runWithoutCodegen(join(root, "dist/main.js"))).toEqual({
      attempts: [],
      result: [true, true, true, true, true, true],
    });
  });

  test("wraps the copy of Zod each importer resolves, before the importer runs", async () => {
    // acme-legacy brings a Zod of its own, which records what `config` sets.
    const root = project({
      ...APP,
      "node_modules/acme-legacy/package.json": manifest("acme-legacy"),
      "node_modules/acme-legacy/index.js": `
        import { config } from "zod";
        export const jitless = config().jitless === true;
      `,
      "node_modules/acme-legacy/node_modules/zod/package.json": manifest("zod", "4.0.0"),
      "node_modules/acme-legacy/node_modules/zod/index.js": `
        const settings = {};
        export function config(changes) { return Object.assign(settings, changes); }
        export default { config };
      `,
      "src/main.js": `
        import { jitless } from "acme-legacy";
        import { z } from "zod";
        globalThis.result = { app: z.config().jitless === true, legacy: jitless };
      `,
    });
    const { modules } = await build(root, [zodJitless()]);

    expect(wrappers(modules, root)).toEqual([
      "zod ./node_modules/acme-legacy/node_modules/zod/index.js",
      "zod zod/index.js",
    ]);
    expect(await runWithoutCodegen(join(root, "dist/main.js"))).toEqual({
      attempts: [],
      result: { app: true, legacy: true },
    });
  });

  test("leaves a dependency's Zod 3 alone, which has no `config` and never compiles", async () => {
    const root = project({
      ...APP,
      "node_modules/acme-old/package.json": manifest("acme-old"),
      "node_modules/acme-old/index.js": `
        import { z } from "zod";
        export const version = z.version;
      `,
      "node_modules/acme-old/node_modules/zod/package.json": manifest("zod", "3.23.8"),
      "node_modules/acme-old/node_modules/zod/index.js": `
        export const z = { version: 3 };
        export default z;
      `,
      "src/main.js": `
        import { version } from "acme-old";
        import { Address } from "acme-forms";
        globalThis.result = { version, valid: Address.safeParse({ city: "Springfield" }).success };
      `,
    });
    const { modules, warnings } = await build(root, [zodJitless()]);

    expect(wrappers(modules, root)).toEqual(["zod zod/index.js"]);
    expect(warnings).toEqual([]);
    expect(await runWithoutCodegen(join(root, "dist/main.js"))).toEqual({
      attempts: [],
      result: { version: 3, valid: true },
    });
  });

  test("leaves the server's build alone", async () => {
    const root = project(APP);
    const { modules } = await build(root, [zodJitless()], { ssr: true });

    expect(wrappers(modules, root)).toEqual([]);
  });
});
