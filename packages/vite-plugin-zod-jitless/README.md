# @rivi-software/vite-plugin-zod-jitless

A Vite plugin that turns on Zod's `jitless` option before any browser module builds a schema, so a Content-Security-Policy without `'unsafe-eval'` never sees Zod probe `new Function`.

Zod 4 compiles a faster parser for an object schema when it can. To find out whether it can, it calls `new Function("")` once, when it builds its first `z.object()`. A policy whose `script-src` lacks `'unsafe-eval'` refuses the call, and the browser logs a violation, fires a `securitypolicyviolation` event and sends a report when the policy names an endpoint, though Zod catches the error and parses without compiling. A report-only policy lets the call through, and Zod then compiles each object schema's parser with `new Function` on its first parse, each compile another report.

`z.config({ jitless: true })` skips the probe, but only for the schemas built after it runs, and the app's entry cannot run it early enough: ES modules run their imports before their own code, and when the bundler splits the app into chunks, a shared chunk with Zod and a schema can run before the module that sets the option. The plugin sets it in front of every module that imports Zod, the app's own and its dependencies', in the build and in the dev server.

## Install

```bash
npm install --save-dev @rivi-software/vite-plugin-zod-jitless
```

It needs Vite 8 and Zod 4, and Node 22 or later.

## Usage

```ts
// vite.config.ts
import { zodJitless } from "@rivi-software/vite-plugin-zod-jitless";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [zodJitless()],
});
```

The app goes on importing `zod` as before. With `jitless` set, Zod parses object schemas without compiling them. Under a policy that refuses `new Function`, that costs nothing, since Zod could not compile there anyway; on a page without one, the plugin gives up Zod's compiled parsers in the browser.

## Options

None. The plugin applies to every environment whose `consumer` is `"client"` and to every Zod entry point listed under [How it works](#how-it-works).

## How it works

In each browser environment, the plugin resolves an import of a Zod entry point as Vite would without it, then gives the importer a small module in its place:

```js
// \0zod-jitless:zod:/app/node_modules/zod/index.js
import * as zod from "/app/node_modules/zod/index.js";
zod.config?.({ jitless: true });
export * from "/app/node_modules/zod/index.js";
export { default } from "/app/node_modules/zod/index.js";
```

A module runs after the modules it imports, so Zod loads first, the wrapper sets the option, and the importer runs last, whichever chunk the bundler put each of them in. The wrapper imports the file the importer resolved, not `zod`, so it is never redirected itself, and each importer keeps the copy of Zod it would have had: a dependency with a Zod of its own gets that copy, made jitless before the dependency runs.

- **Build.** The bundle carries one wrapper for each entry point and copy of Zod, one call each.
- **Dev.** Vite pre-bundles dependencies (`optimizeDeps`) in a bundler run of its own, which runs only the plugins in `optimizeDeps.rolldownOptions.plugins`. The plugin adds itself there, so a pre-bundled dependency that imports Zod gets the wrapper inside its chunk, and the app's own imports get one around Vite's pre-bundled Zod. Vite's dependency scan still sees the imports of Zod itself, so it pre-bundles Zod from the start. Vite hashes the plugin names into its optimizer cache, so adding the plugin pre-bundles the dependencies again on the next start.
- **Server.** Environments whose `consumer` is `"server"`, such as SSR and Workers, are left alone: no browser policy applies there.

It wraps `zod`, `zod/v4`, `zod/mini`, `zod/v4-mini`, `zod/v4/mini` and `zod/v4/core`. It leaves alone `zod/v3`, Zod 3's API, which never compiles; `zod/locales` and `zod/compile`, which build no schema; and the root `zod` of a release before Zod 4, by the `package.json` nearest to the file it resolves to, which a dependency may still bring along and which has no `config`.

## Limits

- **`require()`.** A CommonJS dependency that loads Zod with `require()` gets Zod's CommonJS build, unwrapped. From Zod 4.4 every copy of Zod in a page shares one configuration, so that copy is jitless too when a wrapper ran before it builds its first schema.
- **Web workers.** Vite bundles a worker with the plugins in `worker.plugins`, not `plugins`. A worker that builds schemas needs `worker: { plugins: () => [zodJitless()] }` as well.
- **`z.compile()`** compiles a parser with `new Function` whenever it is called, jitless or not. `zod/compile` respects `jitless` and compiles nothing.
- **Zod inside a dependency's files.** A dependency that ships a copy of Zod bundled into its own files never imports `zod`, so the plugin cannot reach that copy.
- **An external Zod**, left out of the bundle with `build.rolldownOptions.external`, is not wrapped.

## Exports

`@rivi-software/vite-plugin-zod-jitless` exports `zodJitless(): Plugin`.

## Development

The tests build a small app with Vite, or serve it with the dev server, then run what a browser would load in a Node process started with `--disallow-code-generation-from-strings`. That flag refuses `eval` and `new Function` as a policy without `'unsafe-eval'` does, and the process counts every attempt. With the plugin there is none, in the app and in a pre-bundled dependency; without it, Zod's probe shows up. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

[MIT](LICENSE)
