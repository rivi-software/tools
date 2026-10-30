# Contributing

## Setup

Node 24 (`.node-version`; 22.18 and later work too) and pnpm 12:

```bash
pnpm install
pnpm run verify
```

`verify` runs what CI runs, in order: `check:manifests`, `format:check`, `lint` (Oxlint), `check` (TypeScript), `test` (Vitest), `build` and `check:packages`. `pnpm run format` formats the code with Oxfmt. In a package, `pnpm run test`, `pnpm run check` and `pnpm run build` run its own.

## Adding a package

Each package lives in `packages/<name>` and is published as `@rivi-software/<name>`. Name it for what it does and where it runs (`workers-mail`, `vite-plugin-zod-jitless`), not after the app it came from, and write its README for someone who has never seen that app.

```text
packages/<name>/
  LICENSE              a copy of the root LICENSE: npm ships only the package's own
  README.md            what it does, install, usage, how it works, its exports
  package.json
  tsconfig.json
  tsconfig.build.json
  src/
  tests/
```

### package.json

```json
{
  "name": "@rivi-software/<name>",
  "version": "0.1.0",
  "description": "…",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist"],
  "sideEffects": false,
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.build.json",
    "check": "tsc --noEmit",
    "test": "vitest run"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/rivi-software/tools.git",
    "directory": "packages/<name>"
  },
  "homepage": "https://github.com/rivi-software/tools/tree/main/packages/<name>#readme",
  "bugs": "https://github.com/rivi-software/tools/issues",
  "publishConfig": { "access": "public" }
}
```

- A package ships built JavaScript and declarations from `dist/`, nothing else: `exports` lists every entry point, `types` first, and a command line tool is a `bin` in `dist/` whose source starts with `#!/usr/bin/env node`. `pnpm run check:manifests` enforces these fields.
- `repository.url` stays exactly as written: npm compares it with the repository a trusted publish comes from and refuses one that differs.
- What a package plugs into (React, Vite, a framework) is a peer dependency, optional when only one entry point needs it, with the version its tests use in `devDependencies`. Runtime dependencies take caret ranges. TypeScript, Vitest, `@types/node`, Oxlint and Oxfmt come from the root.
- Where a package runs in Node, it supports Node 22, which CI tests beside Node 24 and 26. The types come from `@types/node` 22, so type-checking rejects an API that Node 22 lacks. When Node 22 reaches its end of life on 2027-04-30, the floor moves to 24: `engines`, `@types/node` and the CI matrix together.

### TypeScript

`tsconfig.json` type-checks the sources and tests with the root settings (strict, `NodeNext`); `tsconfig.build.json` adds the root build settings, which emit `src/` to `dist/` with declarations:

```jsonc
// tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src", "tests"] }

// tsconfig.build.json
{ "extends": ["./tsconfig.json", "../../tsconfig.build.json"] }
```

A relative import names the file the build emits, `./util.js` for `src/util.ts`: Node and the declaration files need that name, and Vitest and Vite resolve it to the source.

### Checks

`pnpm run check:packages` (after `pnpm run build`) checks the packages as a consumer gets them from npm. It packs each one as `pnpm publish` would; [arethetypeswrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) reads every entry point's types under Node's ESM and bundler resolution; then plain Node installs the tarballs, with their peers at the versions in `devDependencies`, imports every entry point and checks every `bin`. A `cloudflare:` module resolves to an empty stand-in there, so entry points for Workers load as well.

## Reviews by rivi-bot

A maintainer asks [rivi-bot](rivi-bot) for a review by adding the `rivi-bot:review` label to a pull request. Claude then reviews the commit that was labeled and posts one review with inline comments. The label comes off afterwards, so after a push the label goes on again for another review, which reads only what changed. The review is advice: a maintainer still approves and merges.

The workflow ([`.github/workflows/rivi-bot.yml`](.github/workflows/rivi-bot.yml)) needs the `ANTHROPIC_REVIEW_API_KEY` secret. With the `AUTOMATION_APP_CLIENT_ID` variable and the `AUTOMATION_APP_PRIVATE_KEY` secret of an App installed here, the reviews come from that App rather than `github-actions`.

## Changes and releases

A change to a published package comes with a changeset: run `pnpm changeset`, pick the packages and the bump, and write the line their changelogs get, for the people who use them. A new package needs none; its first version is the one in its `package.json`.

On `main`, the release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)) keeps a "Version packages" pull request open while changesets wait. Merging it publishes every version npm does not have yet, through [trusted publishing](https://docs.npmjs.com/trusted-publishers) with provenance, and tags each release.

### The first release of a new package

npm adds a trusted publisher only to a package that already exists, so a maintainer publishes a new package's first version by hand, once:

1. Merge its pull request. The release workflow then fails to publish the package, which npm does not know yet; step 4 clears that.
2. On an up-to-date `main`, logged in to npm (`npm login`) as a member of the `rivi-software` organization:

   ```bash
   pnpm install
   pnpm --filter @rivi-software/<name> run build
   pnpm --filter @rivi-software/<name> publish --access public
   ```

3. On npmjs.com, under the package's **Settings → Trusted publishing**, add GitHub Actions with organization `rivi-software`, repository `tools` and workflow `release.yml`. Under **Publishing access**, require two-factor authentication and disallow tokens, so only the workflow publishes from then on.
4. Re-run the failed release workflow. It finds the version on npm and passes.
