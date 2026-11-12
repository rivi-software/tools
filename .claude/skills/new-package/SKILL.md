---
name: new-package
description: Adds a new @rivi-software package to this monorepo with everything CI, the labelers and the release workflow expect. Use when asked to create, scaffold or add a package.
---

# Add a package

"Adding a package" in `CONTRIBUTING.md` is the source of truth: read it first. This is the checklist that makes sure none of it is missed.

## 1. Before writing

- A new package starts with an issue a maintainer agreed to. Find it, or ask the user to confirm the agreement.
- Name it for what it does and where it runs (`workers-mail`, `vite-plugin-zod-jitless`), never after the app it came from.
- Pick the existing package closest to it as the model: the same runtime (a Worker, Node, the browser, a Vite plugin) and the same shape (a library, or a `bin`). Copy its structure, never its content.

## 2. The package

In `packages/<name>/`:

- `LICENSE`: a copy of the root `LICENSE`.
- `package.json`: the template in `CONTRIBUTING.md`, at version `0.1.0`, with `repository.url` exactly as written there. Peers for what it plugs into, optional when only one entry point needs them, with the tested version in `devDependencies`. `"engines": { "node": ">=22" }` when it runs in Node. A command line tool is a `bin` in `dist/`, its source starting with `#!/usr/bin/env node`.
- `tsconfig.json` and `tsconfig.build.json`: as in `CONTRIBUTING.md`.
- `src/index.ts`. A relative import names the emitted file: `./util.js` for `src/util.ts`.
- `tests/`: Vitest tests for every export.
- `README.md`: the model's badge row under the title, with the new name in each address; then what it does, install, usage, how it works, limits, exports and development; then the model's License section and RIVI Software sign-off. It is written for someone who has never seen the app it came from: load the `house-style` skill.

## 3. The repository

- `README.md` at the root: a row in the table of packages, in alphabetical order, with the package's npm link and monthly downloads badge.
- `.github/labeler.yml`: a `scope:<name>` entry for `packages/<name>/**`, in alphabetical order with the other packages.
- The `scope:<name>` label. Clef picks an issue's scope by the label's description, so the description says what the package does, like the others (`gh label list --search scope:`). Creating it changes the public repository: show the command and wait for a yes.

  ```bash
  gh label create "scope:<name>" --color 1d76db --description "<what the package does>"
  ```

- `pnpm install`, so the workspace links it and the lockfile has it.
- No changeset: the first version is the one in `package.json`.

## 4. Verify and open the pull request

`pnpm run verify`. Its `check:manifests` checks the manifest, the row in the root README and the line in `labeler.yml`, and its `check:packages` packs the package and imports every entry point as someone installing it from npm would.

Then load the `create-pr` skill, with a `feat(<name>): …` title. Tell the user that the first version is published by hand once the pull request merges ("The first release of a new package" in `CONTRIBUTING.md`): it needs their npm login, then trusted publishing on npmjs.com and public visibility on GitHub Packages.

Done when `verify` passes and every item of "Adding a package" is in the diff or handed to the maintainer.
