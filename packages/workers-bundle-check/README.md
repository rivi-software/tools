# @rivi-software/workers-bundle-check

[![npm version](https://img.shields.io/npm/v/@rivi-software/workers-bundle-check?label=npm&color=0b6b3a)](https://www.npmjs.com/package/@rivi-software/workers-bundle-check) [![CI status](https://img.shields.io/github/actions/workflow/status/rivi-software/tools/ci.yml?branch=main&label=CI)](https://github.com/rivi-software/tools/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-0b6b3a)](LICENSE)

Fails CI on what a Cloudflare Worker's build should not contain.

`wrangler check startup` reports a Worker's size and its startup time, but nothing checks what is inside the build. These mistakes ship without anyone noticing:
- **A module that does not belong in the Worker.** A dev-only mock, a browser-only library or a whole icon set gets pulled in through a chain of imports. The build stays under the size limit, so nothing fails.
- **Source maps served publicly.** The build writes `.map` files into the static assets directory. Unless `.assetsignore` leaves them out, anyone can download the original source.
- **A secret inlined at build time.** A `define` reads an API key or a private key from the environment and writes it into the code.

This package checks a build for all three, from the command line or from a script.

## Install

```bash
npm install --save-dev @rivi-software/workers-bundle-check
```

It needs Node 22.2 or later, and runs after the build, not in the Worker. A configuration file in TypeScript needs Node 22.18 or later. The package is ESM only.

It reads the build's output, so it works with any bundler that writes source maps: the Cloudflare Vite plugin, `wrangler deploy --outdir`, or esbuild of your own. The tests build Workers with Vite 8 (Rolldown) and with Wrangler 4.156.2 (esbuild).

## Usage

Run it after the build, with a configuration file in the project's directory:

```ts
// workers-bundle-check.config.ts
import type { WorkerBundleCheckOptions } from "@rivi-software/workers-bundle-check";

export default {
  serverDir: "dist/server",
  assetsDir: "dist/client",
  forbidden: [
    { module: "msw", reason: "test-only" },
    { module: "**/icons/all.js", reason: "import single icons" },
    { marker: "__DEV_TOOLBAR__", reason: "dev-only code" },
  ],
} satisfies WorkerBundleCheckOptions;
```

```json
{
  "scripts": {
    "build": "vite build && workers-bundle-check"
  }
}
```

The command looks for `workers-bundle-check.config.ts`, `.mts`, `.js`, `.mjs` or `.json` in the current directory, and takes the first it finds. `--config <file>` names another one. `--server <dir>` and `--assets <dir>` override `serverDir` and `assetsDir`, and are enough on their own for the source map and secret checks:

```bash
npx workers-bundle-check --server dist/server --assets dist/client
```

Or call the function from a build script:

```ts
import { checkWorkerBundle } from "@rivi-software/workers-bundle-check";

await checkWorkerBundle({
  serverDir: "dist/server",
  assetsDir: "dist/client",
  forbidden: [{ module: "msw", reason: "test-only" }],
});
```

When it finds a problem, the command prints the problems and exits with `1`, and the function rejects with a `WorkerBundleCheckError`. Its message lists the problems, one per line:

```text
The Worker bundle check found 3 problems:
  dist/server/index.js holds 14 modules (52.1 kB) that "msw" forbids: test-only. The largest is node_modules/.pnpm/msw@2.7.0/node_modules/msw/lib/core/index.mjs (12.0 kB).
  dist/client/assets/index-4f2a.js.map is a source map Wrangler would serve: leave it out with dist/client/.assetsignore, or delete it before the deploy.
  dist/client/assets/index-4f2a.js:1 holds a value shaped like a Stripe secret key (fingerprint 9c1e5b0a7d3f2e48).
```

When it finds none, the function resolves to a report of what it read, and the command prints it.

### Options

| Option | What | Default |
| --- | --- | --- |
| `serverDir` | The Worker's build output: the directory with its JavaScript and source maps | (required) |
| `assetsDir` | The static assets directory, the one `assets.directory` names in the Wrangler config | none: no assets |
| `forbidden` | The modules and markers the Worker must not carry | `[]` |
| `allowedSecrets` | Findings of secrets that are known to be safe | `[]` |
| `secretPatterns` | Kinds of secret to look for besides the built-in ones | `[]` |
| `cwd` | The directory paths are relative to, and module paths are named from | `process.cwd()` |

With the Cloudflare Vite plugin, `serverDir` is the directory that holds the build's `wrangler.json`, such as `dist/server` in a TanStack Start app, and `assetsDir` is the one its `assets.directory` names, such as `dist/client`. With `wrangler deploy --outdir dist`, `serverDir` is `dist`, and `assetsDir` is the directory the Wrangler config's `assets.directory` names.

## Forbidden modules and markers

A rule names a module, a marker or both, and says why. The Worker breaks it when it holds either.

```ts
forbidden: [
  // A package, wherever it is installed: msw's every module.
  { module: "msw", reason: "test-only" },
  // A glob over module paths.
  { module: "src/mocks/**", reason: "dev-only" },
  { module: "**/icons/all.js", reason: "import single icons" },
  // A regular expression over module paths.
  { module: /\/browser\//, reason: "browser-only code" },
  // A string the code must not contain, such as one only dev code has.
  { marker: "__DEV_TOOLBAR__", reason: "dev-only code" },
  // Both: the package, or its marker where no source map names it.
  { module: "yjs", marker: "Yjs was already imported", reason: "the editor loads it lazily" },
],
```

- **A package name**, such as `msw` or `@faker-js/faker`, names every module in that package, wherever it is installed. That covers npm's and pnpm's layouts, and a package nested in another.
- **Any other string** is a glob, matched against the module's path. A module path is relative to `cwd`: `src/server.ts`, or `node_modules/.pnpm/msw@2.7.0/node_modules/msw/lib/core/index.mjs`. `**` matches dot directories such as `.pnpm` too. A module outside `cwd`, such as one in a monorepo's root `node_modules`, is named with its leading `../`, but matched without it. A leading `./` in a glob is left out, so `./src/mocks/**` and `src/mocks/**` are the same. To name a directory named like a package, such as `src`, write `src/**`.
- **A regular expression** is matched against the same path.
- **A marker** is a string or a regular expression that the Worker's code must not contain. It finds code that no source map names, such as a module the bundler inlined, or a bundle built without maps. Names are minified away, so pick a string literal.

The report names each file that breaks a rule, how many of the rule's modules it holds, their size, and the largest one.

### Rules that guard nothing

A rule whose module or marker no longer exists guards nothing. When a library renames `icons/all.js`, the rule against it matches nothing, and the whole icon set could ship again without a failure. The check therefore fails on a rule that matches nothing the project has:
- **A package name**, when the package is not installed where Node would find it from `cwd`. That includes a monorepo's root `node_modules`, and pnpm's store.
- **A glob or a regular expression**, when no file matches it. It looks at the files under `cwd`, and at those in the `node_modules` of each directory above it, following symlinks.
- **A marker with a module pattern**, when none of the files the pattern matches contains it.
- **A marker on its own**, when no file of the project under `cwd`, outside `node_modules`, contains it. For a marker only a package has, name the package as the rule's module too.

What the Worker holds is never stale. The check walks the files only for a rule the Worker does not match, and stops as soon as every rule has matched something.

## Served source maps

The check reads the assets directory's `.assetsignore` the way Wrangler does: in gitignore syntax, with the [`ignore`](https://www.npmjs.com/package/ignore) package Wrangler uses. It leaves out `.assetsignore`, `_headers` and `_redirects` as Wrangler does. It then fails on:
- each `.map` file Wrangler would upload
- each served script or style that carries its source map inline, as a `data:` URL

Any `.assetsignore` that leaves the maps out passes, such as `*.map`, `**/*.map` or `assets/`. A script that names a map Wrangler leaves out is fine: the map is not there to load.

## Values shaped like secrets

The check looks for these key formats in two places:
- the Worker's scripts, HTML, JSON, text, XML and SVG files
- every file the assets would serve, a stray `.env` included, but source maps and binary files such as images and fonts

| Name | Shape |
| --- | --- |
| private key | `-----BEGIN … PRIVATE KEY-----` and the key after it |
| AWS access key ID | `AKIA…`, `ASIA…` (not AWS's `…EXAMPLE` IDs) |
| GitHub token | `ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `ghr_…`, `github_pat_…` |
| GitLab token | `glpat-…` |
| npm token | `npm_…` |
| Slack token | `xoxb-…`, `xoxp-…` and the other `xox` tokens |
| Slack webhook URL | `hooks.slack.com/services/…` |
| Stripe secret key | `sk_live_…`, `sk_test_…`, `rk_live_…`, `rk_test_…` |
| webhook signing secret | `whsec_…` (Stripe, Svix, Clerk) |
| OpenAI API key | `sk-…T3BlbkFJ…` |
| Anthropic API key | `sk-ant-api03-…`, `sk-ant-admin01-…` |
| PostHog personal API key | `phx_…` |
| PostHog project secret key | `phs_…` |
| Supabase secret key | `sb_secret_…` |
| SendGrid API key | `SG.….…` |
| Shopify access token | `shpat_…`, `shpca_…`, `shppa_…`, `shpss_…` |
| Linear API key | `lin_api_…` |
| Hugging Face token | `hf_…` |
| Cloudflare API credential | `cfk_…` (Global API key), `cfut_…` (user API token), `cfat_…` (account API token) |
| Cloudflare Access service token secret | `cfast_…` |

A `cfut_`, `cfat_` or `cfast_` value ends in a checksum: the CRC32 of the 40 characters after its prefix, in lowercase hexadecimal. A value whose checksum is wrong is not reported. A `cfk_` Global API key is found by its shape alone, because what its checksum covers is not confirmed.

Keys that apps ship to browsers on purpose are not in the list: Stripe's publishable `pk_` keys, PostHog's `phc_` project tokens, Supabase's publishable keys, and Google's `AIza` API keys. Add other formats with `secretPatterns`:

```ts
secretPatterns: [
  { name: "internal service token", pattern: /\bsvc_[A-Za-z0-9]{32}\b/ },
  // Reported only when its last 4 characters are the checksum of the rest.
  {
    name: "license key",
    pattern: /\blic_[A-Z0-9]{20}[0-9a-f]{4}\b/,
    verify: (value) => licenseChecksum(value.slice(4, -4)) === value.slice(-4),
  },
],
```

`verify` is optional. It gets each value the pattern matched, and the check reports the value only when `verify` returns `true`, such as when its checksum holds. A wrong `verify` hides a real secret, so give one only for a format whose checksum you know.

The report never prints a value. It gives the file, the line, the module the value comes from when the file has a source map, and a fingerprint: the first 16 hexadecimal digits of the value's SHA-256. The fingerprint stays the same from build to build, while the names of hashed chunks change.

### Allowed secrets

Some findings are safe, such as an example key a library ships. Allow each one by its fingerprint, by the module it comes from, or by both, and say why:

```ts
allowedSecrets: [
  { fingerprint: "9c1e5b0a7d3f2e48", reason: "Stripe's example key, in our docs page" },
  { module: "node-forge", reason: "its test vectors" },
],
```

`module` takes the same patterns as a forbidden rule. An allowed entry that matches no finding fails the check, so the list stays current.

## How it works

- **Which modules the Worker holds.** It reads every `.js`, `.mjs` and `.cjs` file in `serverDir` with its source map. It uses the map the file's `sourceMappingURL` names, inline or in a file, or else `<file>.map` beside it, which is where Vite's `hidden` maps are. A module counts when its mappings cover code in the file. A module the bundler tree-shook away is not in the map, or maps only to the call that initialized it (`init_x()`), which the check leaves out. The size it reports is the length of the module's code in the file.
- **Module paths.** It resolves each source from the map's directory and `sourceRoot`, and names it by its real path, as bundlers do. A package that pnpm links into `node_modules` is named by its path in pnpm's store. Wrangler writes a `sourceRoot` that its own sources do not use. When no file is where `sourceRoot` points, the check looks for the source without it.
- **Matching `.assetsignore`.** It builds the matcher Wrangler builds in `createAssetsIgnoreFunction` (workers-sdk, `packages/workers-shared/utils/helpers.ts`), and tests each file's path in the assets directory against it. The tests compare its result with what `wrangler deploy --dry-run` leaves out, for a dozen `.assetsignore` files.
- **Symbolic links.** It follows them as Wrangler does. In the assets directory, a link to a file is served as that file, and a link to a directory serves the files in it, under the link's path (Wrangler's `buildAssetManifest`). In `serverDir`, a link to a file is read as that file, and a link to a directory is not followed (Wrangler's walk for a Worker's modules). A link to nothing is passed over. A report names a linked file by its path in the assets or in `serverDir`, the one `.assetsignore` matches.

## Limits

- **The modules need source maps.** When a rule names a module and a Worker file has no source map, the check fails, because it cannot see what the file holds. Markers need no maps. Index maps (with `sections`) are not read.
- **It names the module, not the import that pulled it in.** Source maps do not record imports. To find the chain, use the bundler's own analysis, such as esbuild's metafile or a bundle visualizer.
- **Rules check the Worker.** The browser's code in `assetsDir` is checked for source maps and secrets only.
- **Installed is not imported.** In a monorepo, a package installed in the root counts for the stale check even when this app does not depend on it.
- **Yarn Plug'n'Play.** Its packages sit in zip files, which the stale check cannot see into, so it calls a package rule stale unless the Worker holds the package.
- **Secrets have to have a shape.** A key without a prefix, such as an AWS secret access key, a Cloudflare credential in the format from before the `cf…_` prefixes, or a password, has no shape to find. Neither does a value that the build encodes or splits. The check complements a secret scanner on the source, and does not replace it.
- **`assetsDir` is not read from the Wrangler config.** Pass it, or the assets are not checked at all.

## Exports

From `@rivi-software/workers-bundle-check`:

| Export | What |
| --- | --- |
| `checkWorkerBundle(options)` | Checks the build: resolves to a `WorkerBundleReport`, or rejects with a `WorkerBundleCheckError` |
| `WorkerBundleCheckError` | The problems: `report`, with `report.problems`; its message lists them |
| `SECRET_PATTERNS` | The built-in secret patterns: `{ name, pattern, verify? }[]` |
| Types | `WorkerBundleCheckOptions`, `WorkerBundleReport`, `WorkerBundleProblem`, `ForbiddenRule`, `ModulePattern`, `AllowedSecret`, `SecretPattern`, `BundledModule` |

A `WorkerBundleReport` holds `serverDir`, `workerFiles`, `modules` (how many the maps name), `assetsDir`, `servedAssets`, `ignoredAssets`, `allowedSecrets` (how many findings the allow-list let through) and `problems`. Each problem has a `kind` and a one-line `message`:

| `kind` | Fields |
| --- | --- |
| `forbidden-module` | `rule`, `file`, `modules` (`{ path, bytes }`, largest first) |
| `forbidden-marker` | `rule`, `file` |
| `stale-rule` | `rule`, `part` (`module` or `marker`) |
| `missing-source-map` | `file` |
| `served-source-map` | `file` |
| `inline-source-map` | `file` |
| `secret` | `file`, `line`, `name`, `fingerprint`, `module` when known |
| `stale-allowed-secret` | `allowed` |

The `workers-bundle-check` command exits with `0` when the build passes, with `1` when it finds a problem or cannot read the build, and with `2` on a usage error. `workers-bundle-check --help` prints its options.

## Development

The tests in `tests/` cover:
- reading source maps: the mappings, a dropped module's residue, hidden and inline maps, and Wrangler's `sourceRoot`
- matching package names, globs and regular expressions against npm's and pnpm's layouts
- the walk over a monorepo's files, through symlinks
- the agreement with `wrangler deploy --dry-run` on which assets `.assetsignore` leaves out, and on which assets it serves through symbolic links
- each secret pattern, and keys meant to be public
- the whole check on Workers built with Vite (Rolldown) and with Wrangler (esbuild)
- the command and its configuration files

They build and run locally, and call no Cloudflare API. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 RIVI Software.

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>Part of <a href="https://github.com/rivi-software/tools#readme">RIVI tools</a>, the packages <a href="https://rivi.software">RIVI Software</a> builds its own apps with.</sub>
</p>
