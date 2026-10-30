import { describe, expect, test } from "vitest";
import { zodJitless } from "../src/index.js";
import { APP, project, runInDev, serve } from "./support/fixture.js";

// In dev, Vite pre-bundles acme-forms, with the Zod it imports, in a bundler run of its own. Each
// test serves the app, loads every module the browser would from the dev server, and runs them in
// a fresh Node process that refuses to compile strings and counts every attempt.
describe("the dev server", { timeout: 30_000 }, () => {
  test("never compiles a string with the plugin, in the app or a pre-bundled dependency", async () => {
    const root = project(APP);
    const { modules, attempts, result } = await runInDev(root, [zodJitless()]);

    const urls = Object.keys(modules);
    expect(urls.some((url) => url.includes("/@id/__x00__zod-jitless:zod:"))).toBe(true);
    const dependency = urls.find((url) => url.includes("/.vite/deps/acme-forms.js"));
    expect(dependency && modules[dependency]).toContain("jitless: true");
    expect({ attempts, result }).toEqual({ attempts: [], result: { valid: true, invalid: false } });
  });

  test("probes in a pre-bundled dependency with only the resolver, and without the plugin", async () => {
    // The plugin without the half that adds itself to the pre-bundling.
    const { configEnvironment: _, ...resolverOnly } = zodJitless();

    for (const plugins of [[resolverOnly], []]) {
      const { attempts, result } = await runInDev(project(APP), plugins);
      expect({ attempts, result }).toEqual({
        attempts: ["Function"],
        result: { valid: true, invalid: false },
      });
    }
  });

  test("lets the dependency scan find Zod, so Vite pre-bundles it from the start", async () => {
    // Only a module the entry loads later imports Zod: no request finds it before the scan does.
    const root = project({
      "src/main.js": `export const load = () => import("./contact.js");`,
      "src/contact.js": `import { z } from "zod";\nexport const Contact = z.object({});`,
    });
    const optimizer = (await serve(root, [zodJitless()])).environments.client.depsOptimizer;
    await optimizer?.scanProcessing;

    expect(Object.keys(optimizer?.metadata.discovered ?? {})).toEqual(["zod"]);
  });
});
