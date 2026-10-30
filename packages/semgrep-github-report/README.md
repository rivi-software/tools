# @rivi-software/semgrep-github-report

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

`--mode pr` creates or updates the pull request's findings comment; `--mode summary` appends the findings to the job summary, or prints them outside GitHub Actions.

### In GitHub Actions

On a pull request, this workflow scans what the pull request adds over its base branch and comments the findings. Run by hand (`workflow_dispatch`), it scans the whole repository and lists every finding in the job summary.

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

      - name: Comment the findings on the pull request
        if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: npx @rivi-software/semgrep-github-report@0 --mode pr --findings semgrep-findings.json

      - name: List the findings in the job summary
        if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository
        run: npx @rivi-software/semgrep-github-report@0 --mode summary --findings semgrep-findings.json
```

`--config auto` takes rules from the Semgrep Registry for the languages it finds, which Semgrep allows only with its metrics on. To send nothing, scan with your own rules: `--config path/to/rules.yml --metrics off`. `semgrep scan` exits 0 with findings, so the report steps run; it fails the step only when the scan itself fails.

### Pull requests from forks

GitHub gives a pull request from a fork a read-only `GITHUB_TOKEN`, whatever the workflow's `permissions` ask for (unless a private repository's settings send write tokens to forks), so no step can comment on it. The example's step conditions list those pull requests' findings in the job summary instead, on the run's page. Run `--mode pr` on one anyway and GitHub refuses the comment with a 403; the command fails with GitHub's answer and a line that names this cause.

Do not switch to `pull_request_target` for a write token: those runs hold your repository's write access, and once they check out the fork's code to scan it, that code can steer what runs next, `npx` included (an `.npmrc` in the checkout can point it at another registry). Commenting on forks takes a second workflow on `workflow_run` that never checks out their code and treats everything it gets from the fork's run, findings and pull request number alike, as untrusted; this package does not set that up.

### Outside GitHub Actions

Set what GitHub Actions would, and `--mode summary` prints the table:

```bash
semgrep scan --config auto --json --output semgrep-findings.json
GITHUB_REPOSITORY=acme/app npx @rivi-software/semgrep-github-report@0 --mode summary --sha "$(git rev-parse HEAD)"
```

## How it works

The command reads the `results` of `semgrep scan --json` and links each finding to its line at the scanned commit: `$GITHUB_SERVER_URL/<owner>/<repo>/blob/<sha>/<path>#L<line>`.

`--mode pr` reads the pull request's comments, 100 at a time, for the first that contains `<!-- semgrep-scan -->`, the marker that opens every comment it writes.

- With findings, it replaces that comment's body, or creates the comment if there is none.
- Without findings, it replaces an earlier comment's body with "No new findings on this revision.", and comments nothing on a pull request that never had findings.

The comment has a table of the findings (severity, rule ID linked to the rule's page when Semgrep gives a shortlink, location linked to the line), then each finding's message, rule link and fingerprint. The fingerprint is Semgrep's own when Semgrep is logged in; without a login `semgrep scan` reports `requires login` instead, and the command uses the first 40 hex digits of a SHA-256 of the rule ID, path, and start and end lines, which stay the same while the finding does not move.

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
| `GITHUB_SHA`, `GITHUB_EVENT_PATH` | The defaults of `--sha` and `--pr` |
| `GITHUB_STEP_SUMMARY` | The job summary file `--mode summary` appends to |
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

The tests in `tests/` cover the formatting (`index.test.ts`), the command against a stand-in for GitHub's API (`main.test.ts`: finding the comment past the first 100, creating and updating it, a fork's 403, the job summary, the options) and the command as Node runs it (`cli.test.ts`). None of them calls GitHub. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

[MIT](LICENSE)
