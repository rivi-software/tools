# Contributing

Contributions are welcome from anyone: a bug report, a fix, a test, a clearer README, a feature. This guide covers how to propose a change, how to set up the repository, and what a pull request needs before it can merge. From [Adding a package](#adding-a-package) on, it covers the conventions every package follows. [For maintainers](#for-maintainers) covers reviews, releases and the repository's rules.

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Questions, bugs and ideas

[Open an issue](https://github.com/rivi-software/tools/issues/new/choose), after a look through the [existing ones](https://github.com/rivi-software/tools/issues?q=is%3Aissue).

- **A bug.** Name the package and its version, and what it runs on: Node, a Worker or the browser, and the versions of Vite, React or whatever else it plugs into. Then say what you expected and what happened instead. A minimal reproduction gets it fixed fastest. For rivi-bot, give the ref you call it at, the workflow that runs it and your `.github/rivi-bot.yml`.
- **A README that is wrong or unclear.** Say where, and what it should say. A typo or a broken link can go straight to a pull request.
- **A feature or a change in behaviour.** Describe the problem first, then what you would change. Agreeing on it in the issue saves you a pull request that does not merge.
- **A question.** Open an issue too: a question often shows where a README falls short.
- **A vulnerability.** Never in a public issue: [SECURITY.md](SECURITY.md) says how to report one privately.

### Labels

Each issue has a type, and issues and pull requests have labels in a few families. Most are set for you: a pull request gets its scope from the paths it changes, and a new issue gets its type, scope and topics from [Clef](#labels-from-clef).

| Family | Values | Meaning |
| --- | --- | --- |
| Type | Bug, Feature, Task | The issue type, not a label. Bug: something does not do what its README says. Feature: new behaviour, or a change users notice. Task: a chore, refactor, docs, CI or tooling change users do not notice |
| Scope | `scope:<package>`, `scope:rivi-bot`, `scope:repo` | Where the change lands: a package by its directory, the same scope as in a Conventional Commits title. `scope:repo` is CI, releases, scripts and repository-wide docs |
| Topic | `security`, `performance`, `documentation`, `accessibility`, `question`, `breaking-change` | What else it is about. `breaking-change` needs a breaking release, and only a maintainer adds it |
| Triage | `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `duplicate`, `wontfix` | Where an issue stands. `needs-triage` waits for a maintainer, `needs-info` for its author; `ready-for-agent` is specified well enough for a coding agent, `ready-for-human` needs a person |
| Contributors | `good first issue`, `help wanted` | Ready for someone outside the team to take |

The `bug` and `enhancement` labels remain on older issues only: the types replace them.

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

The lint and format rules are [Ultracite](https://www.ultracite.ai)'s presets: `oxlint.config.ts` extends its `core`, `react`, `tanstack`, `vitest` and `anti-slop` presets, and `oxfmt.config.ts` takes its formatting, leaving Markdown and JSON alone. `pnpm run fix` applies Oxlint's fixes, then Oxfmt. It holds back (`-A`) the fixes that would change what the code does or what a package declares, such as `unicorn/prefer-type-error`, which changes the class of a thrown error, and `unicorn/prefer-number-coercion`, which reads `"4.1.12"` as `NaN`. `pnpm run lint` still reports those rules. When a rule is wrong for one line, suppress that line and say why: `// oxlint-disable-next-line eslint/no-await-in-loop -- each page needs the cursor of the page before`. A type assertion needs a `// SAFETY:` comment just before its statement that names what makes it hold.

### Making the change

Work on a branch in your fork. One pull request makes one change, to one package where it can. Two unrelated fixes are two pull requests.

- Changed behaviour comes with a test (Vitest, in the package's `tests/`). A bug fix comes with a test that fails without the fix.
- When what a package does or exports changes, its README changes with it.
- A change to a published package comes with a changeset. Run `pnpm changeset`, pick the package and the bump (`patch` for a fix, `minor` for a feature), and write the line for its changelog, for the people who use the package. Not sure of the bump? Say so in the pull request, and a maintainer settles it. A change only to tests, CI or the repository's own docs needs no changeset.
- A new runtime dependency ends up in every app that installs the package, so it needs a maintainer's agreement in the issue first. pnpm runs a dependency's install script only when `pnpm-workspace.yaml` allows it, and takes no dependency from a git or tarball URL.
- `pnpm run verify` passes before you open the pull request.

### Opening the pull request

- **Title.** It follows [Conventional Commits](https://www.conventionalcommits.org), with the package's directory as the scope: `fix(workers-mail): …`, `feat(deploy-watch): …`, `docs: …`. Pull requests are squash-merged, and the title becomes the commit on `main`.
- **Description.** Say who the change is for and what is wrong for them today, what they will notice after it, and link the issue it closes (`Closes #123`). Show how you know it works: the tests you added or ran, and what you tried by hand. Say whether it needs a changeset, and what a revert would undo. The template has the sections, and a comment in each says what goes there.
- **Allow edits by maintainers.** Leave it checked. A maintainer can then push a small fix to your branch, such as a missing changeset, instead of asking you for it.
- **Draft.** Open the pull request as a draft if you want feedback before it is done.

### What happens next

1. **CI** runs `verify` on Node 22, 24 and 26, on [Depot CI](https://depot.dev/docs/ci/overview), and its `CI / verify` check must pass before the pull request can merge. Depot CI does not run pull requests from forks yet. Once a maintainer has read yours, they copy your commits, unchanged, to a branch here and open a pull request from it, where CI runs. Keep pushing to your own pull request, where the conversation stays: the maintainer copies each push over.
2. **Review.** A maintainer reviews the pull request. They may also ask [rivi-bot](rivi-bot), an automated reviewer that runs on Workers AI, to review it, and it then reviews each later push as well; it only reads the change and comments. Its comments are advice: fix what is right, and reply where it is wrong.
3. **Merge.** A maintainer squash-merges the pull request, or its copy, once the code owner ([`.github/CODEOWNERS`](.github/CODEOWNERS)) approves it and `CI / verify` passes. A copy's commit on `main` names you as a co-author, and your pull request closes with a link to it.
4. **Release.** The next release of the package publishes your changeset to npm (see [Changes and releases](#changes-and-releases)).

### License

The repository is [MIT](LICENSE) licensed. When you open a pull request, you agree that your contribution is released under that license, and you confirm that you have the right to submit it. That means it is your own work, or you say where it came from and under which license. There is no contributor agreement to sign.

### AI tools

You may use AI tools to write an issue or a pull request, and you are its author all the same. Understand every line you submit, run `pnpm run verify` yourself, and say in the pull request what you checked. Fill in the template's Agent context section: which tool and model wrote the code, and how much of it you directed. A maintainer may close a pull request that reads as unreviewed generated output, or a report that nobody can reproduce.

## Adding a package

A new package starts with an issue, like any change bigger than a fix.

Each package lives in `packages/<name>` and is published as `@rivi-software/<name>`. Name it for what it does and where it runs (`workers-mail`, `vite-plugin-zod-jitless`), not after the app it came from, and write its README for someone who has never seen that app. Start the README with the badge row the other packages have, under its title, and end it with their License section and RIVI Software sign-off, with the package's name in the badges' addresses. Add the package to the table of packages in the root README. A maintainer creates its `scope:<name>` label, with a description of what the package does, and the pull request maps it to the package's directory in [`.github/labeler.yml`](.github/labeler.yml). `pnpm run check:manifests` fails until the README's table and `labeler.yml` both list the package.

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

- A package ships built JavaScript and declarations from `dist/`, nothing else: `exports` lists every entry point, `types` first, and a command line tool is a `bin` in `dist/` whose source starts with `#!/usr/bin/env node`. `pnpm run check:manifests` enforces these fields and checks that the rest of the template is there.
- `repository.url` stays exactly as written: npm compares it with the repository a trusted publish comes from and refuses one that differs.
- What a package plugs into (React, Vite, a framework) is a peer dependency, optional when only one entry point needs it, with the version its tests use in `devDependencies`. Runtime dependencies take caret ranges. TypeScript, Vitest, `@types/node`, Oxlint, Oxfmt and Ultracite come from the root.
- Where a package runs in Node, it supports Node 22, which CI tests beside Node 24 and 26, and says so in `engines.node`. `check:manifests` asks for it from a package with a `bin`, or one whose row in the root README says it runs in Node. The types come from `@types/node` 22, so type-checking rejects an API that Node 22 lacks. When Node 22 reaches its end of life on 2027-04-30, the floor moves to 24: `engines`, `@types/node` and the CI matrix together.

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

### CI

CI ([`.depot/workflows/ci.yml`](.depot/workflows/ci.yml)) runs on [Depot CI](https://depot.dev/docs/ci/overview), which reports each job to GitHub as a check from the Depot Code Access app, named `CI / <job>`. `Checks` runs the manifest, format, lint and type checks once; `Test on Node <version>` runs the tests, the build and `check:packages` on Node 22, 24 and 26; `verify` passes when all of them did. `depot ci run --workflow .depot/workflows/ci.yml` runs it on your working tree, unpushed changes included.

The other workflows run on GitHub Actions, from `.github/workflows/`, because Depot CI cannot run them ([its limitations](https://depot.dev/docs/ci/compatibility)):

- [`release.yml`](.github/workflows/release.yml) publishes to npm through trusted publishing, which needs a GitHub-hosted runner's OIDC token: Depot CI's come from Depot. It copies to GitHub Packages with the job's `GITHUB_TOKEN`, and GitHub Packages takes no GitHub App token, which is what Depot CI's `GITHUB_TOKEN` is.
- [`review.yml`](.github/workflows/review.yml) (with [`rivi-bot.yml`](.github/workflows/rivi-bot.yml)) and [`pr-labels.yml`](.github/workflows/pr-labels.yml) run on pull requests from forks too, which Depot CI does not run yet.
- [`issue-labels.yml`](.github/workflows/issue-labels.yml) and [`oss-project.yml`](.github/workflows/oss-project.yml) run when an issue opens, an event Depot CI does not take.
- [`rivi-bot-bun.yml`](.github/workflows/rivi-bot-bun.yml) checks the Bun that rivi-bot's actions install on GitHub's runners, where those actions run in every repository that calls them. It runs only when a pull request or a push changes `rivi-bot/`.

#### A pull request without CI checks

A pull request from a branch here that shows no `CI /` checks at all, `CI / verify` included, most likely has a Depot CI run that failed before any job started. Depot CI starts a pull request's run from GitHub's merge ref, `refs/pull/<number>/merge`. When that ref is still the merge of an earlier commit, Depot CI retries for a few minutes, then fails the run and reports nothing to GitHub. `depot ci rerun` does not help, because a rerun does not rebuild the run. A fork's pull request has no run at all: see [Pull requests from forks](#pull-requests-from-forks).

1. **Find the run.** `depot ci workflow list --repo rivi-software/tools --pr <number>` lists it as `(unnamed)` and `failed`. `depot ci status <run id>` gives its error, which starts with `Merge ref refs/pull/<number>/merge is stale`.

2. **Close and reopen the pull request.** GitHub then rebuilds the merge ref, and Depot CI starts a run on the `reopened` event, with the same commits. A new commit, which the error suggests, may not help: GitHub can leave the merge ref stale through it, and the new run fails in the same way.

   ```bash
   gh pr close <number> && gh pr reopen <number>
   ```

3. **Check the merge ref.** It is current when its second parent is the pull request's head commit, and then the `CI /` checks appear within a minute.

   ```bash
   gh pr view <number> --json headRefOid --jq .headRefOid
   git fetch origin "pull/<number>/merge" && git log -1 --format=%P FETCH_HEAD
   ```

### Pull requests from forks

- **Secrets.** No workflow runs a fork's code with secrets. A workflow on `pull_request_target` has them, so it must not check out the pull request and run it; [rivi-bot's](.github/workflows/rivi-bot.yml) never runs the code it checks out, and [the labeler](.github/workflows/pr-labels.yml) checks out nothing.
- **GitHub Actions runs.** A fork's pull request that changes `rivi-bot/` runs `rivi-bot-bun.yml`, its own version of it. Read the diff before you approve the run for a first-time contributor.
- **Small fixes.** When a pull request lacks only a changeset or a Conventional Commits title, push the changeset to the branch or edit the title yourself. Don't send the contributor round again.

#### Recreating a pull request from a fork

Depot CI does not run pull requests from forks yet, so a fork's pull request gets no `CI / verify` check and cannot merge. A maintainer recreates it: a branch here, `fork/<number>`, with the contributor's commits unchanged, and a pull request from that branch, where CI runs and which merges. The conversation stays on the contributor's pull request. The [`recreate-fork-pr`](.claude/skills/recreate-fork-pr/SKILL.md) skill takes an agent through the same steps.

1. **Read the whole diff.** The branch runs here with this repository's trust: a workflow on it can read the repository's Depot CI secrets, and its runs share Depot Cache with every other branch. Look hardest at `.depot/`, `.github/`, `scripts/`, the `scripts` in a `package.json`, `pnpm-workspace.yaml` and new packages in `pnpm-lock.yaml`. Ask in the pull request about anything unclear, and push nothing until it is answered.

2. **Push the commit you read.** Push its SHA, not the contributor's branch, so a commit they push after you read stays out:

   ```bash
   gh pr view <number> --json isCrossRepository,headRefOid,author,title,maintainerCanModify
   git fetch origin "pull/<number>/head"
   git rev-parse FETCH_HEAD # the headRefOid you read
   git push origin "<headRefOid>:refs/heads/fork/<number>"
   ```

3. **Open the copy.** It has the original's title, and its body starts with `Recreates #<number> by @<author>, with their commits unchanged, so CI runs on Depot CI.`, followed by the original's sections. Comment on the original with a link to the copy, and say the conversation stays there.

4. **Copy each later push.** Read what changed, then push the new head over the copy. `git range-diff` shows each commit's change, a rebase included:

   ```bash
   git fetch origin main "pull/<number>/head"
   git range-diff origin/main <old sha> <new sha>
   git push --force-with-lease="refs/heads/fork/<number>:<old sha>" origin "<new sha>:refs/heads/fork/<number>"
   ```

   A small fix of your own, such as a missing changeset, goes to the contributor's branch when the original allows edits by maintainers, and then over to the copy. Otherwise push it to `fork/<number>` alone and say so on the original.

5. **Merge the copy.** Squash-merge it once `CI / verify` passes and the code owner approves. The commit message ends with a `Co-authored-by:` line for each author of the contributor's commits: `git log --format='Co-authored-by: %an <%ae>' origin/main..origin/fork/<number> | sort -u` lists them, and you add one that is missing. Then close the original with a link to the commit on `main`, and delete `fork/<number>`.

rivi-bot counts the copy as a maintainer's pull request: it reviews each push on its own, and can approve the copy, where on the original it would only comment. Its approval counts for nothing in the ruleset, and it read text from outside the team: give it the weight of a comment.

### Reviews by rivi-bot

[rivi-bot](rivi-bot) reviews a pull request by someone with write access to the repository on its own: when it opens or leaves draft, and after every push. It posts one review with inline comments per commit, and approves when nothing has to change. An approval stands for the commit it read: the next review dismisses it first.

Any other pull request waits for a maintainer, who asks for reviews by adding the `rivi-bot:review` label. Read the pull request first: the reviews spend Workers AI tokens, and the model reads everything in the pull request. It reviews the commit that was labeled. The label stays on, so each later push is reviewed too, up to a follow-up's budget each, until a maintainer takes the label off. These reviews comment and never approve, because an outside pull request could carry text written to steer a review into approving. To retry a review that failed, re-run its workflow run.

A review after the first reads only what changed since the last one. A push to a draft is not reviewed, but the label still asks for a review of a draft. Either way the review is advice: a maintainer still approves and merges.

The workflow ([`.github/workflows/review.yml`](.github/workflows/review.yml)) calls the reusable one in [`.github/workflows/rivi-bot.yml`](.github/workflows/rivi-bot.yml), and needs the `CLOUDFLARE_ACCOUNT_ID` variable and the `CLOUDFLARE_AI_API_TOKEN` secret: the review runs on Workers AI (`@cf/deepseek-ai/deepseek-v4.1-flash-1017`) through the authenticated AI Gateway `github-rivi-tools`, as [Clef's labels](#labels-from-clef) do, with a spend limit of $25 a month and 300 calls an hour that the two share, so the token needs **Workers AI Read** and **AI Gateway Run**, unless `CLOUDFLARE_AI_GATEWAY_TOKEN` holds the gateway's own token. The `ANTHROPIC_REVIEW_API_KEY` secret is for reading requests to rivi-bot in plain words, which run on Claude. With the `AUTOMATION_APP_CLIENT_ID` variable and the `AUTOMATION_APP_PRIVATE_KEY` secret of an App installed here, the reviews come from that App rather than `github-actions`. Other repositories call `rivi-bot.yml` at `main`, so a change to it or to an action in `rivi-bot/` reaches them as soon as it merges.

### Labels from Clef

Two workflows add [the labels](#labels), as the App above, and neither takes a label off:

- **Pull requests.** [`pr-labels.yml`](.github/workflows/pr-labels.yml) adds the `scope:*` label of each path a pull request changes, as [`.github/labeler.yml`](.github/labeler.yml) maps them, when it opens and after each push.
- **Issues.** [`issue-labels.yml`](.github/workflows/issue-labels.yml) runs [`scripts/label-issue.ts`](scripts/label-issue.ts) when an issue opens. It asks [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), Cloudflare's decision model on Workers AI, about what the issue lacks: its type and its scope, each as a choice between the options; each topic label but `breaking-change`, as a yes or no; and the organization's Priority and Effort fields, as a level on a rubric. Clef returns a probability for every option. A type under 60% or a scope under 50% is left for a maintainer, and a topic is added only at 80% or more; the job summary lists each answer with its probability. An issue from outside the team also gets `needs-triage` when it opens. A label, type or field value someone set stays, including one set while Clef answered, and a label someone took off is never added again.

The options for the scope and the topics are the repository's labels, and Clef decides between them by their descriptions: keep a label's description to what its package does, and a new package needs only its label (and its line in `labeler.yml`). The thresholds, rubrics and types are in [`scripts/issue-labels.ts`](scripts/issue-labels.ts).

The issue labeler is off until the `RIVI_BOT_AI_ENABLED` variable is `true`. It needs the `CLOUDFLARE_ACCOUNT_ID` variable and the `CLOUDFLARE_AI_API_TOKEN` secret, a Cloudflare API token with Workers AI Read; and the `CLOUDFLARE_AI_GATEWAY_TOKEN` secret, with AI Gateway Run, unless the first token has that too. Clef's calls go through the authenticated AI Gateway `github-rivi-tools`, which logs them (an issue is public anyway), with a spend limit of $25 a month and 300 calls an hour, shared with rivi-bot's reviews; a call costs well under a cent. To label an issue that opened before, or again, run the workflow by hand with its number; a run by hand adds no `needs-triage`.

### The open-source project

The organization's open issues and pull requests in its public repositories, this one and every one after it, are on one public project: [RIVI Open Source](https://github.com/orgs/rivi-software/projects/2). Its Status runs Triage → Backlog → Todo → In Progress → In Review → Done.

[`oss-project.yml`](.github/workflows/oss-project.yml) adds them, as the App above, which needs **Organization → Projects: Read and write**. It runs [`scripts/add-to-project.ts`](scripts/add-to-project.ts) every half hour, when an issue or a pull request opens here, and by hand. A search finds the items that are not on the project yet, so a new public repository needs nothing to take part. An issue starts in Triage, a pull request in In Review and a draft in In Progress. What a bot opened stays off, such as the release pull request and Dependabot's, and so does an item that closed before the run read it. Each run also gives a starting Status to every open card that has none: one whose Status could not be set when it was added, or one added by hand. An item that fails does not stop the others; the run fails at the end, and the next one tries again. The project's own workflows move the cards from there. To take a card off the board, archive it: the next run adds a deleted card again.

### Changes and releases

A change to a published package comes with a changeset ([Making the change](#making-the-change)). A new package needs none; its first version is the one in its `package.json`.

On `main`, the release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)) keeps a "Version packages" pull request open while changesets wait. Merging it publishes every version npm does not have yet, through [trusted publishing](https://docs.npmjs.com/trusted-publishers) with provenance, and tags each release.

RIVI Bot, [the App above](#reviews-by-rivi-bot), opens and updates that pull request, and writes the tags and GitHub releases, with a token the workflow mints from the `AUTOMATION_APP_CLIENT_ID` variable and the `AUTOMATION_APP_PRIVATE_KEY` secret. The App needs **Contents: write** and **Pull requests: write**. Its commits are signed and authored by the App.

The workflow's next job copies to GitHub Packages every release that npm has and GitHub Packages lacks, with [`scripts/mirror-github-packages.ts`](scripts/mirror-github-packages.ts) and the job's `GITHUB_TOKEN`. It publishes npm's own tarball once it matches the integrity npm lists, so both registries serve the same bytes. It copies releases oldest first, and a run catches up on whatever an earlier one missed, so it needs no backfill by hand: re-run the job to retry. GitHub Packages has no `npm dist-tag`, so each copy is published with a tag that ends up where npm's points; `node scripts/mirror-github-packages.ts --dry-run` lists the copies and their tags. GitHub Packages links each package to this repository through the `repository` field, and takes its access from the repository.

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
4. Re-run the failed release workflow. It finds the version on npm and passes, and its next job copies the version to GitHub Packages.
5. Make the package public on GitHub Packages, which creates every new package private whatever the repository's visibility: in the organization's **Packages**, open the package, then **Package settings → Danger Zone → Change visibility → Public**. There is no API for it, and a public package cannot be made private again.

#### A rivi-bot release

rivi-bot has no changesets and no npm package. A version is a `rivi-bot-v<major>.<minor>.<patch>` tag on `main`, with a GitHub release. It matters to a repository that pins the actions themselves: the reusable workflow runs them from `main`, so its callers get every change as soon as it merges.

A maintainer cuts a release once a change to `rivi-bot/` or the reusable workflow has merged that callers who pin should get. The release raises one part of the version:

- **Major** for a change a caller has to act on, such as an input or output removed or renamed, or a default that changes what runs. Its pull request title has a `!`, such as `feat(rivi-bot)!: …`.
- **Minor** for something new: an action, an input or a behaviour. Its title starts with `feat`.
- **Patch** for a fix, and for anything else. A security fix gets its tag as soon as it merges, and its advisory names that version as patched.

1. Run the [rivi-bot release workflow](.github/workflows/rivi-bot-release.yml) from `main`, under **Actions → rivi-bot release → Run workflow**, or with `gh workflow run rivi-bot-release.yml --ref main`. With `bump` at `auto`, the version follows the commit titles since the last tag; choose `major`, `minor` or `patch` when a title gets it wrong. `commit` releases a commit of `main` other than its head.
2. The workflow stops when the commit is not on `main`, when `CI / verify` has not passed on it, when nothing in `rivi-bot/` or the reusable workflow changed since the last release, or when another rivi-bot release waits as a draft. Otherwise it drafts the release, with notes that list the commits, and its job summary links the draft. [`scripts/release-rivi-bot.ts`](scripts/release-rivi-bot.ts) says how to run it on a clone with `--dry-run`, which drafts nothing.
3. Rewrite the draft's notes for the people who run rivi-bot, under the headings that apply: Security, Changes, and Upgrading for what a caller has to do. [rivi-bot-v1.0.0](https://github.com/rivi-software/tools/releases/tag/rivi-bot-v1.0.0) shows the shape.
4. Publish the draft. Publishing creates the tag on the commit the draft names, and a tag is never moved, so the workflow tags nothing itself.

### Rulesets

GitHub enforces the repository's rulesets; [`.github/rulesets/`](.github/rulesets) holds them and is their source of truth.

- **`main.json`.** `main` changes only through pull requests, squashed, once the `CI / verify` check from the Depot Code Access app passes and the code owner approves. `CI / verify` is the job in [`.depot/workflows/ci.yml`](.depot/workflows/ci.yml) that passes when the checks and every Node version passed. Nobody pushes to `main` directly, force-pushes or deletes it.
  - [`.github/CODEOWNERS`](.github/CODEOWNERS) makes `rikvisser-dev` the owner of every file, so every pull request needs their approval. A review by anyone else, rivi-bot's included, is advice.
  - `rikvisser-dev` can bypass the rules in a pull request only. GitHub does not let an author approve their own pull request, so they bypass the approval to merge their own. A bypass merges without waiting for any rule, `CI / verify` included, so wait for `CI / verify` first.
  - A branch need not be up to date with `main` before it merges. Without a merge queue, that would rerun CI on every open pull request after each merge.
- **`release-tags.json`.** A release tag (`@rivi-software/<name>@<version>`, `rivi-bot-v*`) is created once and is never moved or deleted, because users pin to it.

To change a ruleset, edit its file in a pull request, then apply it:

```bash
gh api repos/rivi-software/tools/rulesets --jq '.[] | "\(.id) \(.name)"'
gh api -X PUT repos/rivi-software/tools/rulesets/<id> --input .github/rulesets/main.json
```

To add a new ruleset: `gh api -X POST repos/rivi-software/tools/rulesets --input .github/rulesets/<name>.json`.
