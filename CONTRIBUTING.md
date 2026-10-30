# Contributing

Contributions are welcome from anyone: a bug report, a fix, a test, a clearer README, a feature. This guide covers how to propose a change, how to set up the repository, and what a pull request needs before it can merge. From [Adding a package](#adding-a-package) on, it covers the conventions every package follows. [For maintainers](#for-maintainers) covers reviews, releases and the repository's rules.

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Questions, bugs and ideas

[Open an issue](https://github.com/rivi-software/tools/issues/new/choose), after a look through the [existing ones](https://github.com/rivi-software/tools/issues?q=is%3Aissue).

- **A bug.** Name the package and its version, and what it runs on: Node, a Worker or the browser, and the versions of Vite, React or whatever else it plugs into. Then say what you expected and what happened instead. A minimal reproduction gets it fixed fastest.
- **A feature or a change in behaviour.** Describe the problem first, then what you would change. Agreeing on it in the issue saves you a pull request that does not merge.
- **A question.** Open an issue too: a question often shows where a README falls short.
- **A vulnerability.** Never in a public issue: [SECURITY.md](SECURITY.md) says how to report one privately.

## Your pull request

A typo, a broken link, a clearer sentence, or a bug fix with a test can go straight to a pull request. Anything bigger starts with an issue: a new feature, a change to what a package does or exports, a new dependency, or a new package. Wait for a maintainer to agree on the approach there before you write it.

Issues labeled [`good first issue`](https://github.com/rivi-software/tools/labels/good%20first%20issue) or [`help wanted`](https://github.com/rivi-software/tools/labels/help%20wanted) are ready to take. Say in the issue that you are on it, so nobody else starts the same work.

### Setup

Node 24 (`.node-version`; 22.18 and later work too) and pnpm 12 ([installation](https://pnpm.io/installation)). Fork the repository, then:

```bash
git clone https://github.com/<your-username>/tools.git
cd tools
pnpm install
pnpm run verify
```

`verify` runs what CI runs, in order: `check:manifests`, `format:check`, `lint` (Oxlint), `check` (TypeScript), `test` (Vitest), `build` and `check:packages`. `pnpm run format` formats the code with Oxfmt. In a package, `pnpm run test`, `pnpm run check` and `pnpm run build` run its own.

### Making the change

Work on a branch in your fork. One pull request makes one change, to one package where it can. Two unrelated fixes are two pull requests.

- Changed behaviour comes with a test (Vitest, in the package's `tests/`). A bug fix comes with a test that fails without the fix.
- When what a package does or exports changes, its README changes with it.
- A change to a published package comes with a changeset. Run `pnpm changeset`, pick the package and the bump (`patch` for a fix, `minor` for a feature), and write the line for its changelog, for the people who use the package. Not sure of the bump? Say so in the pull request, and a maintainer settles it. A change only to tests, CI or the repository's own docs needs no changeset.
- A new runtime dependency ends up in every app that installs the package, so it needs a maintainer's agreement in the issue first. pnpm runs a dependency's install script only when `pnpm-workspace.yaml` allows it, and takes no dependency from a git or tarball URL.
- `pnpm run verify` passes before you open the pull request.

### Opening the pull request

- **Title.** It follows [Conventional Commits](https://www.conventionalcommits.org), with the package's directory as the scope: `fix(workers-mail): …`, `feat(deploy-watch): …`, `docs: …`. Pull requests are squash-merged, and the title becomes the commit on `main`.
- **Description.** Say what changes and why, and link the issue it closes (`Closes #123`). Show how you know it works: the tests you added or ran, and what you tried by hand. The template has the sections.
- **Allow edits by maintainers.** Leave it checked. A maintainer can then push a small fix to your branch, such as a missing changeset, instead of asking you for it.
- **Draft.** Open the pull request as a draft if you want feedback before it is done.

### What happens next

1. **CI** runs `verify` on Node 22, 24 and 26, and its `verify` check must pass before the pull request can merge. Until a first pull request of yours has merged here, GitHub waits for a maintainer to approve each run before it starts.
2. **Review.** A maintainer reviews the pull request. They may also ask [rivi-bot](rivi-bot), an automated reviewer that runs Claude, to review it, and it then reviews each later push as well; it only reads the change and comments. Its comments are advice: fix what is right, and reply where it is wrong.
3. **Merge.** A maintainer squash-merges the pull request once it is reviewed and `verify` passes.
4. **Release.** The next release of the package publishes your changeset to npm (see [Changes and releases](#changes-and-releases)).

### License

The repository is [MIT](LICENSE) licensed. When you open a pull request, you agree that your contribution is released under that license, and you confirm that you have the right to submit it. That means it is your own work, or you say where it came from and under which license. There is no contributor agreement to sign.

### AI tools

You may use AI tools to write an issue or a pull request, and you are its author all the same. Understand every line you submit, run `pnpm run verify` yourself, and say in the pull request what you checked. A maintainer may close a pull request that reads as unreviewed generated output, or a report that nobody can reproduce.

## Adding a package

A new package starts with an issue, like any change bigger than a fix.

Each package lives in `packages/<name>` and is published as `@rivi-software/<name>`. Name it for what it does and where it runs (`workers-mail`, `vite-plugin-zod-jitless`), not after the app it came from, and write its README for someone who has never seen that app. Add it to the table of packages in the root README.

```text
packages/<name>/
  LICENSE              a copy of the root LICENSE: npm ships only the package's own
  README.md            what it does, install, usage, how it works, limits, exports, development
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

## For maintainers

### Pull requests from forks

- **CI runs.** Read the diff before you approve a CI run for a first-time contributor. CI runs the pull request's own code: its install, tests, build and scripts. It gets a read-only token and no secrets, but nothing should run that nobody has read. Look hardest at `.github/`, `scripts/`, the `scripts` in a `package.json` and `pnpm-workspace.yaml`.
- **Secrets.** No workflow runs a fork's code with secrets. A workflow on `pull_request_target` has them, so it must not check out the pull request and run it; [rivi-bot's](.github/workflows/rivi-bot.yml) only reads the code it checks out.
- **Small fixes.** When a pull request lacks only a changeset or a Conventional Commits title, push the changeset to the branch or edit the title yourself. Don't send the contributor round again.

### Reviews by rivi-bot

[rivi-bot](rivi-bot) reviews a pull request by someone with write access to the repository on its own: when it opens or leaves draft, and after every push. It posts one review with inline comments per commit, and approves when nothing has to change. An approval stands for the commit it read: the next review dismisses it first.

Any other pull request waits for a maintainer, who asks for reviews by adding the `rivi-bot:review` label. Read the pull request first: the reviews spend the API key's budget, and Claude reads everything in the pull request. Claude reviews the commit that was labeled. The label stays on, so each later push is reviewed too, up to a follow-up's budget each, until a maintainer takes the label off. These reviews comment and never approve, because an outside pull request could carry text written to steer a review into approving. To retry a review that failed, re-run its workflow run.

A review after the first reads only what changed since the last one. A push to a draft is not reviewed, but the label still asks for a review of a draft. Either way the review is advice: a maintainer still approves and merges.

The workflow ([`.github/workflows/rivi-bot.yml`](.github/workflows/rivi-bot.yml)) needs the `ANTHROPIC_REVIEW_API_KEY` secret. With the `AUTOMATION_APP_CLIENT_ID` variable and the `AUTOMATION_APP_PRIVATE_KEY` secret of an App installed here, the reviews come from that App rather than `github-actions`.

### Changes and releases

A change to a published package comes with a changeset ([Making the change](#making-the-change)). A new package needs none; its first version is the one in its `package.json`.

On `main`, the release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)) keeps a "Version packages" pull request open while changesets wait. Merging it publishes every version npm does not have yet, through [trusted publishing](https://docs.npmjs.com/trusted-publishers) with provenance, and tags each release.

#### The first release of a new package

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

### Rulesets

GitHub enforces the repository's rulesets; [`.github/rulesets/`](.github/rulesets) holds them and is their source of truth.

- **`main.json`.** `main` changes only through pull requests, squashed, once the `verify` check passes: CI's job that passes when every Node version passed. Nobody pushes to `main` directly, force-pushes or deletes it, and nobody bypasses the rules.
  - No approval is required. A review, rivi-bot's included, is advice.
  - A branch need not be up to date with `main` before it merges. Without a merge queue, that would rerun CI on every open pull request after each merge.
- **`release-tags.json`.** A release tag (`@rivi-software/<name>@<version>`, `rivi-bot-v*`) is created once and is never moved or deleted, because users pin to it.

To change a ruleset, edit its file in a pull request, then apply it:

```bash
gh api repos/rivi-software/tools/rulesets --jq '.[] | "\(.id) \(.name)"'
gh api -X PUT repos/rivi-software/tools/rulesets/<id> --input .github/rulesets/main.json
```

To add a new ruleset: `gh api -X POST repos/rivi-software/tools/rulesets --input .github/rulesets/<name>.json`.
