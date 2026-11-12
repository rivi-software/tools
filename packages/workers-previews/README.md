# @rivi-software/workers-previews

[![npm version](https://img.shields.io/npm/v/@rivi-software/workers-previews?label=npm&color=0b6b3a)](https://www.npmjs.com/package/@rivi-software/workers-previews) [![CI status](https://img.shields.io/github/check-runs/rivi-software/tools/main?nameFilter=CI%20%2F%20verify&label=CI)](https://github.com/rivi-software/tools/commits/main) [![MIT License](https://img.shields.io/badge/license-MIT-0b6b3a)](LICENSE)

Names [Workers Previews](https://developers.cloudflare.com/workers/previews/) after their branch, and cleans them up once the branch is done.

`wrangler preview` creates and updates one Preview for each branch, and leaves the cleanup to you. Cloudflare's docs delete a pull request's Preview when the pull request closes. That one step misses:
- **Previews that outlive their branch.** The close workflow failed or was skipped, or the branch was deleted without a pull request. Preview URLs are public by default, and a forgotten Preview keeps serving old code against the shared preview data. Cloudflare removes the least recently deployed Preview only once a Worker reaches its limit (100 Previews on Free, 500 on paid plans).
- **Branch names that make no valid name.** A Preview's hostname label holds at most 63 characters, Worker name included, and two branches can reduce to the same slug.
- **A cleanup that races a build.** A Preview deleted while a Workers Build of its branch still runs comes back when the build deploys, or fails the build.
- **The Git integration's duplicate.** With a deploy script that names its Previews, Cloudflare's Git integration still creates an empty Preview under the raw branch name beside it.

This package is the command line tool RIVI Software runs its Previews with, and the functions behind it:
- `cf-previews deploy` runs `wrangler preview` under a name made from the branch: a short slug and a hash of the exact branch name, which fits the label, and which no other branch gets.
- `cf-previews delete` deletes a branch's Previews, the Git integration's duplicate included. While a Workers Build of the branch runs, it refuses and says so.
- `cf-previews list` lists the Worker's Previews, each with its branch, its last deployment and whether the branch still exists.
- `cf-previews sweep` compares every Preview with the live branches and the pull requests, and with `--apply` deletes the stale ones. It deletes nothing when it cannot read the whole branch list.

## Install

```bash
npm install --save-dev @rivi-software/workers-previews
```

It needs Node 22 or later, and is ESM only. `deploy` runs your project's own Wrangler, which needs to be 4.135.0 or later for Previews; Wrangler is an optional peer dependency, since the other commands only call Cloudflare's API. It depends on [`@rivi-software/cloudflare-deploy`](https://github.com/rivi-software/tools/tree/main/packages/cloudflare-deploy#readme) for that API's client.

## Usage

```text
cf-previews deploy [--branch <name>] [--worker <name>] [-- <wrangler preview options>]
cf-previews delete [--branch <name>] [--worker <name>] [--skip-build-check]
cf-previews list   [--worker <name>] [--repository <owner/name>] [--json]
cf-previews sweep  [--apply] [--worker <name>] [--repository <owner/name>] [--keep <preview>]... [--skip-build-check]
cf-previews name   [--branch <name>]
```

| Option | Default |
| --- | --- |
| `--branch` | The branch CI runs for: `WORKERS_CI_BRANCH` on Workers Builds; `GITHUB_HEAD_REF` on a pull request, else `GITHUB_REF_NAME` on a branch, on GitHub Actions; `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`, else `CI_COMMIT_BRANCH`, on GitLab CI. Elsewhere, Git's current branch |
| `--worker` | `WRANGLER_CI_OVERRIDE_NAME`, the Worker Workers Builds is building. `deploy` can do without it: Wrangler then takes the name from its config. The others need one |
| `--production-branch` | `main`. It gets no Preview, and the sweep keeps a Preview of that name |
| `--repository` | `GITHUB_REPOSITORY`, as GitHub Actions sets it |
| `--keep` | None. A Preview the sweep never deletes, such as one you named by hand; repeat it for more |
| `--apply` | Off: the sweep only lists what it would delete |
| `--skip-build-check` | Off: `delete` and `sweep --apply` ask Workers Builds first |
| `--json` | Off: `list` prints a table |

Arguments after `--` go to `wrangler preview` as they are, such as `--config dist/server/wrangler.json` or `--secrets-file`. `--name` and `--worker-name` are `cf-previews`' to set.

The commands exit with `1` when they fail, and with `2` on a usage error.

### Tokens

| Variable | For | Needs |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `delete`, `list`, `sweep` | The account's ID |
| `CLOUDFLARE_API_TOKEN` | `delete`, `list`, `sweep` (else the token `wrangler login` holds) | **Workers Scripts: Edit**; Read is enough for `list` and a sweep without `--apply` |
| `CLOUDFLARE_BUILDS_API_TOKEN` | The build check of `delete` and `sweep --apply` (default `CLOUDFLARE_API_TOKEN`) | A **user** API token with **Workers Builds Configuration: Read**. The Builds API refuses account-owned tokens |
| `GITHUB_TOKEN` | `list`, `sweep` | `contents: read` and `pull-requests: read`. A public repository can do without |
| `GITHUB_API_URL` | `list`, `sweep` | GitHub Enterprise Server's API, which GitHub Actions sets there |

`deploy` calls no API itself: Wrangler deploys with its own credentials. For a Worker that Workers Builds does not build, pass `--skip-build-check`, and the account token is all `delete` and `sweep` need.

### On Workers Builds

Set the Worker's [Preview command](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) in its build settings to:

```bash
npx cf-previews deploy
```

Workers Builds sets the branch and the Worker. Add `-- --config <path>` when the deploy needs a config other than the project's own, such as the one the Cloudflare Vite plugin writes.

### On GitHub Actions

In the job that deploys a pull request's Preview:

```yaml
- name: Deploy the Preview
  id: preview
  run: npx cf-previews deploy
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

The step's outputs are `preview_name` and `preview_url`, the Preview's first URL. The job summary gets a line with both.

To delete a branch's Previews when its pull request closes, and when the branch is deleted without one:

```yaml
name: Delete Previews

on:
  pull_request:
    types: [closed]
  delete:

permissions:
  contents: read

jobs:
  delete:
    # A fork's pull request gets no secrets, and its branch no Preview of yours.
    if: >-
      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)
      || github.event.ref_type == 'branch'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: npx --yes --package @rivi-software/workers-previews@0 cf-previews delete --worker my-app --branch "$BRANCH"
        env:
          # The branch goes through the environment, never into the script itself.
          BRANCH: ${{ github.event_name == 'delete' && github.event.ref || github.head_ref }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_BUILDS_API_TOKEN: ${{ secrets.CLOUDFLARE_BUILDS_API_TOKEN }}
```

### A nightly sweep

The sweep catches whatever the delete workflow missed:

```yaml
name: Sweep Previews

on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read

jobs:
  sweep:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: npx --yes --package @rivi-software/workers-previews@0 cf-previews sweep --worker my-app --apply
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_BUILDS_API_TOKEN: ${{ secrets.CLOUDFLARE_BUILDS_API_TOKEN }}
          GITHUB_TOKEN: ${{ github.token }}
```

A job without a checkout runs the package through `npx --package`: `npx cf-previews` alone would look for a package named `cf-previews`. Run the sweep without `--apply` first, and read what it would delete. It prints a table and writes it to the job summary:

```text
Action  Preview                Branch          Reason
delete  b-featur-1651b1dc9e7d  feature-news    every pull request from the branch is closed
keep    b-rt-1-a33d8c625833    rt-1            open pull request
delete  feature-news           feature-news    every pull request from the branch is closed
keep    main                   main            production branch
delete  pr-12                  #12 (old/work)  pull request closed
3 of 5 Previews of my-app are stale
Nothing was deleted: run the sweep with --apply to delete them.
```

A delete that fails, such as one whose branch is building, does not stop the others. The sweep then exits with `1` once it has tried them all.

### Preview secrets

`wrangler preview secret` takes the Preview's name, which `cf-previews name` prints:

```bash
npx wrangler preview secret put API_KEY --name "$(npx cf-previews name)"
```

## How it works

### The name

`previewName(branch)` is `b-`, the first six characters of the branch as a slug (lowercase, every run of other characters one `-`), `-`, and the first 12 hexadecimal characters of the SHA-256 of the exact branch name: `feature/News` becomes `b-featur-dbec97bc6ac2`, and `feature-news` becomes `b-featur-1651b1dc9e7d`.

It is at most 21 characters, all of them lowercase letters, digits and hyphens, as a hostname takes them. A Preview's workers.dev host starts with the label `<preview>-<worker>`, which holds 63 characters, so the Worker's name can have up to 41. With `--worker`, `deploy` refuses a longer one before it runs Wrangler. The name of a branch never changes, so each deploy updates the branch's Preview rather than adding one.

### What the sweep deletes

The sweep reads the Worker's Previews from Cloudflare, then the repository's branches and pull requests from GitHub, both in full, before it deletes anything. A Preview deployed while the sweep runs is either missing from its list or has its branch in the repository's: the sweep never takes it for a deleted branch's. It takes each Preview's branch from its name:

| Name | Branch | Stale when |
| --- | --- | --- |
| The production branch | | Never |
| One `previewName` gives | The branch or pull request whose `previewName` it is | The branch is stale, or nothing known hashes to it |
| `pr-<number>`, as in Cloudflare's GitHub Actions example | The pull request's | The pull request is not open |
| Any other | The name itself, as `wrangler preview` and the Git integration name Previews | The branch is stale |

A branch is stale once it is deleted, unless a pull request from it is still open, or when it is live and every pull request from it is closed. A live branch that never had a pull request keeps its Preview. The sweep deletes a stale branch's two Previews together, its hashed name and its raw name, as `delete` does.

It reads every branch and every open pull request. It reads only the 1,000 most recently updated closed pull requests: one it misses only keeps a Preview longer. A pull request from a fork counts only for its `pr-<number>` Preview, which it keeps while it is open. Its branch is not the repository's, so it keeps no other Preview, even one with the same branch name.

### When it refuses

The sweep deletes nothing when:
- GitHub or Cloudflare answers an error.
- GitHub's branches or open pull requests run past 100 pages of 100. It follows GitHub's `Link` header, and reads on after a full page even without one.
- The branches lack the production branch: the token reads another repository, or `--production-branch` is wrong.

`delete`, and the sweep for each branch, first ask the Workers Builds API for the Worker's builds of the last 90 days. A build of the branch that is queued, initializing or running stops the delete, and so does one that names no branch. A hashed name whose branch is unknown waits for every build of the Worker. A Worker that Workers Builds never built has none.

## From code

The functions behind the commands take a client from `@rivi-software/cloudflare-deploy/cloudflare-api`. `sweepPreviews` takes the repository's state from a function, so another Git host can supply it:

```ts
import { cloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import { sweepPreviews, type RepositoryState } from "@rivi-software/workers-previews";

const api = cloudflareApi({ accountId, token, retry: { attempts: 5 } });

const result = await sweepPreviews({
  api,
  worker: "my-app",
  builds: cloudflareApi({ accountId, token: buildsToken }),
  repository: async (): Promise<RepositoryState> => ({
    branches: await listBranchesFromGitLab(),
    pullRequests: (await listMergeRequests()).map((request) => ({
      number: request.iid,
      branch: request.source_branch,
      open: request.state === "opened",
      fork: request.source_project_id !== request.target_project_id,
    })),
  }),
  apply: true,
  log: console.log,
});
if (result.failed.length) process.exitCode = 1;
```

The function must return every live branch and every open pull request, and throw when it cannot.

## Limits

- **The hash is 48 bits.** Two branches could in principle share a name; among a few thousand branches the odds are below one in ten million.
- **A raw name is a branch name.** A Preview named by hand, not after a branch, looks like a deleted branch's to the sweep. Keep it with `--keep <name>`.
- **The build check can be overtaken.** A build that starts after the check and before the delete brings its Preview back. The next sweep removes it again, once the branch is stale.
- **GitHub only, on the command line.** For another host, call `sweepPreviews` with your own `repository` function.
- **Just the Preview.** Deleting a Preview deletes its deployments. A container app it ran stays, as do any resources a Preview made for itself, such as a database; see Cloudflare's [Resources and isolation](https://developers.cloudflare.com/workers/previews/resources/).

## Exports

From `@rivi-software/workers-previews` (Node):

| Export | What |
| --- | --- |
| `previewName(branch, { productionBranch?, worker? })` | The branch's Preview name. Throws for the production branch, and, with `worker`, for a label over 63 characters |
| `isPreviewName(name)` | Whether `name` has the form `previewName` gives |
| `deployPreview(options)` | Runs `wrangler preview` under the branch's name: `{ worker, name, id, urls, deploymentId, deploymentUrls }`. Options `branch`, `productionBranch`, `worker`, `args`, `cwd`, `env`, `run` |
| `deleteBranchPreviews(target, branch)` | Deletes the branch's hashed and raw Previews once its builds are idle; answers the names it deleted |
| `previewInventory(target)` | Each Preview with its owner, `branchExists`, `deployedOn` and the sweep's verdict |
| `sweepPreviews(target)` | `{ entries, targets, deleted, failed }`; deletes only with `apply` |
| `planSweep(previews, repository, { productionBranch?, keep? })` | The sweep's decision, without calling anything: `{ entries, targets }` |
| `previewOwner(name, repository, { productionBranch? })` | Where a Preview's name comes from |
| `githubRepository({ repository, token?, apiUrl?, closedPages?, fetch? })` | A function that reads the repository's state from GitHub |
| `listPreviews(api, worker)`, `deletePreview(api, worker, name)` | The Workers API's Previews of a Worker |
| `workerTag(api, worker)`, `activeBuilds(api, tag, branch?)` | The Worker's tag, and its unfinished Workers Builds |
| `readPreviewResult(output, { name, worker? })` | The Preview record in Wrangler's output file |
| `targetLabel(target)`, `MAX_LABEL_LENGTH` | How the sweep names a target; 63 |
| Types | `PreviewNameOptions`, `PreviewsTarget` (`api`, `worker`, `builds`, `productionBranch`, `log`), `PreviewEntry`, `SweepResult`, `SweepEntry`, `SweepTarget`, `SweepPlan`, `SweepOptions`, `PreviewOwner`, `RepositoryState`, `PullRequest`, `PreviewInfo`, `BuildInfo`, `GitHubRepositoryOptions`, `DeployPreviewOptions`, `DeployedPreview` |

## Development

The tests in `tests/` cover:
- the names, pinned to the ones existing Previews have
- the sweep's decisions
- the Cloudflare and GitHub calls, against a fake of both APIs: paging, refusing a list it could not finish, forks, the build check
- `deploy` against a stand-in for Wrangler, and its output file
- the command, end to end against the fakes

None of them calls Cloudflare or GitHub. The type check and the tests read `@rivi-software/cloudflare-deploy` from its sources, so they need no build first; the build reads its built files. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

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
