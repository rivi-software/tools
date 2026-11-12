# @rivi-software/semgrep-github-report

[![npm version](https://img.shields.io/npm/v/@rivi-software/semgrep-github-report?label=npm&color=0b6b3a)](https://www.npmjs.com/package/@rivi-software/semgrep-github-report) [![CI status](https://img.shields.io/github/check-runs/rivi-software/tools/main?nameFilter=CI%20%2F%20verify&label=CI)](https://github.com/rivi-software/tools/commits/main) [![MIT License](https://img.shields.io/badge/license-MIT-0b6b3a)](LICENSE)

Reports [Semgrep](https://semgrep.dev) findings on GitHub with nothing but the job's `GITHUB_TOKEN`. On a pull request it keeps one comment up to date: it comments when findings first appear, edits that comment on every later run, and says so there once they are gone. On a full scan it lists the findings in the job summary. It needs no Semgrep account or `SEMGREP_APP_TOKEN`, files no issues, and does not fail a check over findings.

`semgrep scan --json` leaves its findings in a file few people open, and Semgrep's own pull request comments come with its AppSec Platform, which needs an account and a token. This command turns the open-source CLI's JSON into the comment and the summary.

## Install

In GitHub Actions there is nothing to install: a step runs it with `npx` ([below](#in-github-actions)). To pin it with your project's other tools:

```bash
npm install --save-dev @rivi-software/semgrep-github-report
```

It needs Node 22 or later and has no dependencies.

## Usage

```text
semgrep-github-report --mode pr|summary [--findings <file>] [--pr <number>] [--sha <commit>]
```

`--mode pr` creates or updates the pull request's findings comment, or lists the findings in the job summary when the pull request comes from a fork; `--mode summary` appends the findings to the job summary, or prints them outside GitHub Actions.

### In GitHub Actions

On a pull request, this workflow scans what the pull request adds over its base branch and comments the findings, or lists them in the job summary for a pull request from a fork. Run by hand (`workflow_dispatch`), it scans the whole repository and lists every finding in the job summary.

```yaml
name: Semgrep

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

# A newer run on the same pull request cancels the older, so two runs never write the comment at once.
concurrency:
  group: semgrep-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  semgrep:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write # the findings comment
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # --baseline-commit needs the base branch's history
          persist-credentials: false

      - name: Install Semgrep
        run: |
          python3 -m venv "$RUNNER_TEMP/semgrep"
          "$RUNNER_TEMP/semgrep/bin/pip" install semgrep==1.178.0
          echo "$RUNNER_TEMP/semgrep/bin" >> "$GITHUB_PATH"

      # A pull request's scan reports only what it adds over its base.
      - name: Scan
        env:
          BASELINE: ${{ github.event.pull_request.base.sha }}
        run: |
          args=(--config auto --json --output semgrep-findings.json)
          if [ -n "$BASELINE" ]; then args+=(--baseline-commit "$BASELINE"); fi
          semgrep scan "${args[@]}"

      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24

      # A pull request from a fork gets its findings in the job summary instead.
      - name: Comment the findings on the pull request
        if: github.event_name == 'pull_request'
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: npx @rivi-software/semgrep-github-report@0 --mode pr --findings semgrep-findings.json

      - name: List the findings in the job summary
        if: github.event_name != 'pull_request'
        run: npx @rivi-software/semgrep-github-report@0 --mode summary --findings semgrep-findings.json
```

`--config auto` takes rules from the Semgrep Registry for the languages it finds, which Semgrep allows only with its metrics on. To send nothing, scan with your own rules: `--config path/to/rules.yml --metrics off`. `semgrep scan` exits 0 with findings, so the report steps run; it fails the step only when the scan itself fails.

### Pull requests from forks

GitHub gives a pull request from a fork a read-only `GITHUB_TOKEN`, whatever the workflow's `permissions` ask for, so no step can comment on it. `--mode pr` tells such a pull request apart by the event in `GITHUB_EVENT_PATH`: when the pull request's head repository (`pull_request.head.repo.full_name`) is not `GITHUB_REPOSITORY`, or the fork is gone, it lists the findings in the job summary, on the run's page, as `--mode summary` does. It prints a line that says why, makes no request to GitHub and exits 0, so a workflow needs no step condition for forks. A 403 on a pull request from the repository itself still fails the step, with a line that names the missing `pull-requests: write`.

The command decides by the event alone. So a pull request from a fork gets the job summary on `pull_request_target` too, and in a private repository whose settings send write tokens to forks.

Do not switch to `pull_request_target` for a write token: those runs hold your repository's write access, and once they check out the fork's code to scan it, that code can steer what runs next, `npx` included (an `.npmrc` in the checkout can point it at another registry). Commenting on forks takes a second workflow on `workflow_run` that never checks out their code and treats everything it gets from the fork's run, findings and pull request number alike, as untrusted; this package does not set that up.

### Outside GitHub Actions

Set what GitHub Actions would, and `--mode summary` prints the table:

```bash
semgrep scan --config auto --json --output semgrep-findings.json
GITHUB_REPOSITORY=acme/app npx @rivi-software/semgrep-github-report@0 --mode summary --sha "$(git rev-parse HEAD)"
```

## How it works

The command reads the `results` of `semgrep scan --json` and links each finding to its line at the scanned commit: `$GITHUB_SERVER_URL/<owner>/<repo>/blob/<sha>/<path>#L<line>`.

On a pull request from a fork, `--mode pr` does what `--mode summary` does ([above](#pull-requests-from-forks)). On any other, it reads the pull request's comments, 100 at a time, for the first that contains `<!-- semgrep-scan -->`, the marker that opens every comment it writes.

- With findings, it replaces that comment's body, or creates the comment if there is none.
- Without findings, it replaces an earlier comment's body with "No new findings on this revision.", and comments nothing on a pull request that never had findings.

The comment has a table of the findings (severity, rule ID linked to the rule's page when Semgrep gives a shortlink, location linked to the line), then each finding's message, rule link and fingerprint. The fingerprint is Semgrep's own when Semgrep is logged in; without a login `semgrep scan` reports `requires login` instead, and the command uses the first 40 hex digits of a SHA-256 of the rule ID, path, and start and end lines, which stay the same while the finding does not move.

A finding's path and message can hold text from the scanned code, which the pull request's author wrote, so the comment shows them as written. The path and the rule ID go in code spans, on one line, with each `|` escaped in the table. In a message, an invisible zero-width joiner (U+200D) goes after an `@` that would mention someone, a `<` that would open HTML such as `<!--`, and an `&` that would open a character reference such as `&#64;`, and before a line's ```` ``` ```` or `~~~`. So a mention notifies nobody, and nothing hides the rest of the comment or turns it into code. Links and email addresses keep working, and text copied from a message can carry those joiners. The job summary's table is written the same way.

`--mode summary` appends the same table, under a heading with the commit and the number of findings, to the file in `GITHUB_STEP_SUMMARY`; where that is not set, it prints it.

It prints what it did, such as the comment's URL. When it cannot do it (bad options, findings it cannot read, a request GitHub refuses or never answers), it prints why and exits 1. It calls the API at `GITHUB_API_URL`, so it works on GitHub Enterprise Server too.

On a `pull_request` event, `GITHUB_SHA` is the merge commit of the pull request into its base, the commit `actions/checkout` checks out by default, so the links show the lines Semgrep scanned. If you check out the head commit instead (`ref: ${{ github.event.pull_request.head.sha }}`), pass that SHA with `--sha` too: a step cannot set `GITHUB_SHA` itself, as GitHub ignores a step's `env` for its default `GITHUB_*` variables.

## Options

| Option | Default | |
| --- | --- | --- |
| `--mode pr`, `--mode summary` | required | Comment on the pull request, or list the findings in the job summary |
| `--findings <file>` | `semgrep-findings.json` | What `semgrep scan --json --output <file>` wrote |
| `--pr <number>` | `pull_request.number` from the event in `GITHUB_EVENT_PATH` | The pull request to comment on, for `--mode pr` |
| `--sha <commit>` | `GITHUB_SHA` | The commit Semgrep scanned, which the links point at |
| `-h`, `--help` | | Prints the usage |

| Environment | |
| --- | --- |
| `GITHUB_TOKEN` | For `--mode pr`: a token that may write pull request comments, in GitHub Actions `${{ github.token }}` with `pull-requests: write` |
| `GITHUB_REPOSITORY` | `owner/repo` |
| `GITHUB_SHA`, `GITHUB_EVENT_PATH` | The defaults of `--sha` and `--pr`. The event also says whether the pull request comes from a fork |
| `GITHUB_STEP_SUMMARY` | The job summary file that `--mode summary`, and `--mode pr` on a pull request from a fork, append to |
| `GITHUB_API_URL`, `GITHUB_SERVER_URL` | GitHub's API and web addresses, `https://api.github.com` and `https://github.com` by default |

GitHub Actions sets all of them but `GITHUB_TOKEN`, which the step passes.

## Programmatic use

The package exports the functions the command formats with; they do no I/O.

```ts
import { readFileSync } from "node:fs";
import { formatFindingsSummary, parseFindings } from "@rivi-software/semgrep-github-report";

const findings = parseFindings(readFileSync("semgrep-findings.json", "utf8"));
const markdown = formatFindingsSummary(findings, { repository: "acme/app", sha: "4c0ffee" });
```

| Export | |
| --- | --- |
| `parseFindings(json)` | The `results` in the text of `semgrep scan --json` output; throws if there is no `results` array |
| `formatFindingsComment(findings, revision)` | The pull request comment's Markdown, the marker first and within GitHub's 65,536 characters |
| `formatFindingsSummary(findings, revision)` | The job summary's Markdown |
| `semgrepFingerprint(finding)` | Semgrep's fingerprint of the finding, or the hash used without a login |
| `COMMENT_MARKER` | `<!-- semgrep-scan -->` |
| `SemgrepFinding` | A finding as `semgrep scan --json` writes it, with the fields the package reads |
| `Revision` | `{ repository, sha, serverUrl? }`: where the links point; `serverUrl` defaults to `https://github.com` |

## Limits

- **One comment per pull request.** Every run that reports on a pull request edits the same comment, so two jobs that report different scans on one pull request overwrite each other's findings.
- **Runs at the same time.** Two runs on a pull request without a comment can each create one; the example's `concurrency` group prevents that.
- **Comment length.** GitHub takes at most 65,536 characters in a comment, roughly 60 findings with registry-length messages. Past that, the comment leaves out the messages, then the table rows that do not fit, and its last line says so; a local `semgrep scan` shows them all.
- **Job summary size.** GitHub drops a step's summary over 1 MiB, some 4,000 findings, with an error annotation; the step still passes.
- **Paths.** The links use the paths Semgrep reports, relative to where it ran: scan from the repository root.
- **JSON only.** It reads the JSON output of `semgrep scan`, not SARIF.
- **Findings do not fail the check.** It exits 0 whatever it finds. To fail on findings, add `--error` to `semgrep scan`, which then exits 1 when it finds something, and write the report steps' conditions as `${{ !cancelled() && … }}` so they still run.

## Development

The tests in `tests/` cover the formatting (`index.test.ts`), the command against a stand-in for GitHub's API (`main.test.ts`: finding the comment past the first 100, creating and updating it, a pull request from a fork, a refused comment, the job summary, the options) and the command as Node runs it (`cli.test.ts`). None of them calls GitHub. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

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
