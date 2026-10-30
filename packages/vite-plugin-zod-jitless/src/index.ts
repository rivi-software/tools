import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin, Rolldown } from "vite";

/**
 * Zod's entry points that can build a schema, with whether each has a default export to pass on;
 * both hold from Zod 3.25 to 4.6. `zod/v3` never compiles a parser, and `zod/locales` and
 * `zod/compile` build no schema.
 */
const ENTRIES = new Map([
  ["zod", true],
  ["zod/v4", true],
  ["zod/mini", false],
  ["zod/v4-mini", false],
  ["zod/v4/mini", false],
  ["zod/v4/core", false],
]);
const ENTRY = new RegExp(`^(?:${[...ENTRIES.keys()].join("|")})$`);

// A wrapper's id names the entry point and the module it wraps, as the importer resolved it:
// \0zod-jitless:zod/v4:/app/node_modules/zod/v4/index.js
const PREFIX = "\0zod-jitless:";
const WRAPPER = /^\0zod-jitless:/;

type Resolver = Pick<Rolldown.PluginContext, "resolve">;
type ResolveOptions = { kind?: Rolldown.ImportKind; custom?: Rolldown.CustomPluginOptions };

/** Whether `file` belongs to a release of Zod before 4, by the package.json nearest to it. */
function isZod3(file: string): boolean {
  let dir = dirname(file.split("?")[0]);
  while (!existsSync(join(dir, "package.json"))) {
    if (dir === dirname(dir)) return false;
    dir = dirname(dir);
  }
  try {
    const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return name === "zod" && Number.parseInt(version, 10) < 4;
  } catch {
    return false;
  }
}

/**
 * Resolves an import of a Zod entry point as it resolves without this plugin and wraps what it
 * finds, so each importer keeps its own copy of Zod and that copy is jitless before the importer
 * runs. A `require()`, an external or virtual module, and the API of Zod 3 pass unwrapped.
 */
async function resolveWrapper(
  this: Resolver,
  source: string,
  importer: string | undefined,
  options: ResolveOptions,
): Promise<Rolldown.ResolveIdResult> {
  if (!ENTRIES.has(source) || !importer || WRAPPER.test(importer)) return;
  if (options.kind === "require-call") return;
  const resolved = await this.resolve(source, importer, {
    kind: options.kind,
    custom: options.custom,
    skipSelf: true,
  });
  if (!resolved || resolved.external || resolved.id.startsWith("\0")) return resolved;
  // zod@3's root entry is Zod 3, which has no `config` and never compiles a parser.
  if (source === "zod" && isZod3(resolved.id)) return resolved;
  return `${PREFIX}${source}:${resolved.id}`;
}

/**
 * The wrapper. The module it wraps evaluates first; then `config` makes that copy of Zod jitless,
 * and only then do the modules that import the wrapper run. It declares the call a side effect,
 * which a build that assumes none (`treeshake.moduleSideEffects: false`) would otherwise drop.
 */
function loadWrapper(id: string): Rolldown.LoadResult {
  if (!WRAPPER.test(id)) return;
  const separator = id.indexOf(":", PREFIX.length);
  const target = JSON.stringify(id.slice(separator + 1));
  const lines = [
    `import * as zod from ${target};`,
    `zod.config?.({ jitless: true });`,
    `export * from ${target};`,
  ];
  if (ENTRIES.get(id.slice(PREFIX.length, separator)))
    lines.push(`export { default } from ${target};`);
  return { code: lines.join("\n"), map: { mappings: "" }, moduleSideEffects: true };
}

/**
 * Resolves every browser import of Zod, the app's own and its dependencies', to a wrapper that
 * makes Zod jitless before the importing module runs. Without it Zod 4 probes `new Function` when
 * it builds an object schema, and a Content-Security-Policy whose `script-src` lacks
 * 'unsafe-eval' reports the probe, though Zod catches the error.
 *
 * It applies to each environment whose consumer is the browser: in the build, and in dev, where it
 * also wraps the imports inside the dependencies Vite pre-bundles.
 */
export function zodJitless(): Plugin {
  const resolveId = { filter: { id: ENTRY }, handler: resolveWrapper };
  const load = { filter: { id: WRAPPER }, handler: loadWrapper };
  return {
    name: "zod-jitless",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.config.consumer === "client",
    // In dev, Vite pre-bundles dependencies in a bundler run of its own, whose only plugins are
    // those in `optimizeDeps.rolldownOptions`.
    configEnvironment(name, config) {
      if ((config.consumer ?? (name === "client" ? "client" : "server")) !== "client") return;
      const optimizer = { name: "zod-jitless:optimizer", resolveId, load };
      return { optimizeDeps: { rolldownOptions: { plugins: [optimizer] } } };
    },
    resolveId: {
      ...resolveId,
      handler(source, importer, options) {
        // Vite's dependency scan passes over a virtual module without recording it: it has to see
        // Zod itself to pre-bundle Zod before a request asks for it.
        if ((options as { scan?: boolean }).scan) return;
        return resolveWrapper.call(this, source, importer, options);
      },
    },
    load,
  };
}
