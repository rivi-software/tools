# rivi-bot

Claude on a repository's pull requests and issues, as GitHub Actions. It reviews pull requests: Claude reads the pull request at one commit, with read-only tools, and posts one review with an inline comment for each finding, pinned to that commit. A repository can also have it describe pull requests, triage issues, fix review findings, answer questions and report on the backlog, each turned on and shaped in [one configuration file](#configuration).

RIVI Software runs it as RIVI Bot on its own repositories, through [a reusable workflow](../.github/workflows/rivi-bot.yml) that any repository can call. Without a configuration file, it only reviews: a pull request by someone with write access when it opens and after every push, and any other pull request once a maintainer adds the `rivi-bot:review` label.

## What it does

| Feature | Runs | What it writes | Default |
| --- | --- | --- | --- |
| [review](#review) | When a pull request opens and after every push; `/rivi-bot review` | One review with inline comments, pinned to the commit it read | On |
| [describe](#describe) | When a pull request opens; `/rivi-bot describe` | A summary in the pull request's description, and labels | Off |
| [triage](#triage) | When an issue opens; `/rivi-bot triage` | One comment: what the issue is, possible duplicates, what is missing, where to look, an approach, and a prompt for a coding agent; and labels | Off |
| [fix](#fix) | `/rivi-bot fix` | A commit on the pull request's branch that fixes the open review findings | Off |
| [ask](#ask) | `/rivi-bot ask <question>` | An answer to a question about a pull request or an issue | Off |
| [housekeeping](#housekeeping) | On the caller's schedule | One issue that reports on the open issues and pull requests; labels, if asked | Off |

What runs on its own, without a command, follows each feature's `auto` setting: for the author of a pull request or an issue who can write to the repository (`internal`, the default), for anyone (`everyone`), or for nobody (`off`).

## Setup

1. Add an Anthropic API key as an Actions secret, such as `ANTHROPIC_REVIEW_API_KEY`. Use a key from a workspace with a spend limit.
2. Create the `rivi-bot:review` label, which approves the reviews of a pull request. Adding a label needs triage access; the workflow also checks for write access.
3. Optionally, use a GitHub App installed on the repository, so that rivi-bot posts as the App instead of `github-actions`, and so that CI runs on the commits [fix](#fix) pushes. Keep its client ID in an Actions variable and its private key in a secret. It needs **Contents: read** and **Pull requests: write**, and also **Issues: write** for triage, ask and housekeeping, and **Contents: write** for fix.
4. Add a workflow that calls the reusable workflow. The events it listens to and the permissions it grants are the most rivi-bot can do; [the configuration](#configuration) chooses what it does:

```yaml
name: rivi-bot
on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize, labeled]
  issues: # triage
    types: [opened]
  issue_comment: # commands
    types: [created]
  schedule: # housekeeping
    - cron: "0 6 * * 1"
  workflow_dispatch: # housekeeping, by hand
permissions: {}
jobs:
  rivi-bot:
    uses: rivi-software/tools/.github/workflows/rivi-bot.yml@main
    permissions:
      contents: write # fix pushes; read is enough without it
      issues: write # triage, ask and housekeeping
      pull-requests: write
    with:
      app-client-id: ${{ vars.AUTOMATION_APP_CLIENT_ID }} # optional
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_REVIEW_API_KEY }}
      app-private-key: ${{ secrets.AUTOMATION_APP_PRIVATE_KEY }} # optional
```

For reviews alone, listen to `pull_request_target` and grant `contents: read` and `pull-requests: write`, as [this repository's workflow](../.github/workflows/review.yml) does. A job that needs a permission the caller did not grant fails when it runs, and says which.

5. Optionally, add `.github/rivi-bot.yml` to turn features on.

| Workflow input | What |
| --- | --- |
| `app-client-id` | The client ID of the App rivi-bot posts as; without it, it posts as `github-actions` |
| `config-path` | The configuration file, `.github/rivi-bot.yml` by default |
| `focus` | What else reviews look for; `review.focus` in the configuration takes its place |

| Workflow secret | What |
| --- | --- |
| `anthropic-api-key` | (required) The key Claude runs on |
| `app-private-key` | The private key of the App named by `app-client-id` |

## Configuration

`.github/rivi-bot.yml`, read from the default branch: a pull request that edits it changes nothing until it merges. Every key is optional; these are the defaults:

```yaml
model: claude-opus-5-5 # each feature's model unless it names its own

review:
  enabled: true
  auto: internal # whose pull requests are reviewed without the label or a command
  approve: true # a review of an internal pull request approves when nothing has to change
  follow-up: true # after a first review, review only what changed since
  focus: "" # what else to look for
  model: "" # the top-level model

describe:
  enabled: false
  auto: internal # whose pull requests are described when they open
  summary: true # a summary in the description
  labels: true # the repository's labels that fit
  instructions: "" # what else the summary covers, or how

triage:
  enabled: false
  auto: internal # whose issues are triaged when they open
  labels: true # the repository's labels that fit
  duplicates: true # earlier issues that look like the same one
  questions: true # what the issue leaves out
  plan: true # the files involved and an approach
  prompt: true # a prompt to hand a coding agent
  instructions: ""

fix:
  enabled: false
  instructions: "" # how fixes are made here, such as "update CHANGELOG.md"

ask:
  enabled: false

housekeeping:
  enabled: false
  stale-days: 30 # the days without activity after which the report calls something quiet
  labels: false # also label the open issues that have none, rather than only suggest labels
  instructions: ""
```

`auto` is `internal` (the author can write to the repository), `everyone` or `off`. `focus` and `instructions` can run to several lines, for a repository's review rules or its triage conventions. A setting of the wrong type stops the run with an error that names it, and a key that is not a setting is reported as a warning.

## Commands

Someone with write access gives a command with a comment that starts with `/rivi-bot`. The comment gets an eyes (👀) reaction, and the command runs if its feature is on. Anything after the command, to the end of the comment, is passed along.

| Command | On | Does |
| --- | --- | --- |
| `/rivi-bot review [instructions]` | A pull request | One review of its head now; the instructions may narrow or steer it |
| `/rivi-bot describe` | A pull request | Writes its summary again, and adds labels |
| `/rivi-bot fix [instructions]` | A pull request | Fixes the open review findings, and anything the instructions add |
| `/rivi-bot triage [instructions]` | An issue | Triages it, or triages it again |
| `/rivi-bot ask <question>` | Either | Answers the question |

A command from someone without write access is ignored. `/rivi-bot review` approves an outside pull request's review the way the label does, but for that one review.

## Review

- **What it reads.**
  - The diff from the base to the commit under review
  - The pull request's title, description, commits and conversation
  - Earlier reviews and review threads, so it does not repeat a finding that was answered or fixed
  - Any file in a checkout of that commit
  - The repository's own guides (AGENTS.md, CONTRIBUTING.md, the READMEs), for the conventions it holds a change to
- **What it looks for.**
  - Bugs and unhandled cases
  - Security holes
  - Secrets or personal data where they should not be
  - Breaking changes to public APIs, published packages or data formats
  - Changed behaviour without a test
  - Documents the change makes untrue
  - `focus`, for what your repository adds to that list

  Style and lint are left to CI.
- **What it writes.** One inline comment per finding, with a suggestion block when the fix is a few lines it is sure of. Then exactly one review on the commit it read: a short body with the findings that need a change, one line each. The review comments; it approves only with `approve`, which the reusable workflow passes only for a pull request by someone with write access. It never requests changes and never posts a plain comment.
- **When.** A pull request by someone with write access when it opens or leaves draft, and after every push (`auto: internal`). Any other pull request once a maintainer adds the `rivi-bot:review` label, and after every push while the label stays on, until a maintainer takes it off; or once, with `/rivi-bot review`. A push to a draft is not reviewed, but the label still asks for a review of a draft.
- **Approvals.** An approval stands for the commit it read. Before a review of a later commit, the reviewer's earlier approvals on the pull request are dismissed, and the new review approves again if nothing has to change.
- **Follow-up reviews.** After an earlier review by the same login, it reads only what changed since the commit that review read. It replays that commit's changes onto the pull request's current fork point (`git merge-tree`), so a rebase onto the base, or a merge of it, is not reviewed again. If nothing changed but the base, there is no review.
- **Budget.**
  - A whole pull request runs at high effort, with up to 40 turns and $10.
  - A follow-up runs at medium effort, with up to 20 turns and $3.
  - The API key's workspace spend limit is the hard cap.

## Describe

Reads the pull request, its diff and the checkout, and writes a summary for whoever reviews it: what changes and why, the changes that matter, and what to look at closely. The summary goes at the end of the description, between markers of its own, and replaces itself the next time; the author's text is left as it is. It also adds the repository's labels that fit, from those the repository has. It runs when a pull request opens, reopens or leaves draft, not after each push: `/rivi-bot describe` writes it again. Medium effort, up to 15 turns and $2.

## Triage

Reads the issue, its comments, the repository's other issues and the default branch, and posts one comment, which a later triage edits rather than adds to:

- What the issue reports or asks, and what kind of issue it is, with what the code shows that the reporter could not know
- Earlier issues that look like the same one (`duplicates`)
- What the reporter left out that a maintainer needs (`questions`)
- The files involved and an approach (`plan`)
- A prompt to hand a coding agent, folded away (`prompt`)

It also adds the repository's labels that fit (`labels`). A duplicate is named only if that issue exists, a file only if the checkout has it. Medium effort, up to 25 turns and $2.

An issue can come from anyone, and with `auto: everyone` each new one spends up to the triage budget, and Claude reads text written by whoever opened it. What Claude writes is limited to the comment and labels above, but the comment's text can still be steered by the issue.

## Fix

`/rivi-bot fix` on a pull request whose branch is in this repository fixes its open review findings: the review threads nobody has resolved, started by rivi-bot or by someone with write access. Claude reads the threads, with only the comments by those same people, rivi-bot's last review, the diff and the checkout, and edits the files with the smallest change each finding needs. It leaves a finding alone when the thread says it is not a problem, when it is a decision for the author, or when it is not sure of the fix. Instructions after the command narrow the fix or add to it: `/rivi-bot fix only the null check`.

It runs nothing, not even the tests: the commit is code nobody has read yet, and the comment after it says what was fixed and what was left. The commit is pushed onto the commit the fix was made on, never with force; if the branch moved on meanwhile, nothing is pushed. A fix never changes `.github/`. A push with `github.token` starts no workflows, so CI runs on the fix only with an App. Pull requests from forks are not fixed: their branches are not this repository's to push to. High effort, up to 40 turns and $5.

## Ask

`/rivi-bot ask <question>` on a pull request or an issue answers the question in a comment, from the thread and the code: a pull request's head, or an issue's default branch. It names files as `path:line`, and says where it is unsure. It changes nothing. Medium effort, up to 25 turns and $2.

## Housekeeping

On the caller's schedule, or started by hand, rivi-bot reads the open issues and pull requests, the most recently merged pull requests and the default branch, and keeps one issue with a report on them, labeled `rivi-bot:housekeeping`. Each run rewrites it; close it, and the next run opens a new one. The report lists:

- Pull requests approved but not merged, with changes requested, with conflicts, and quiet for `stale-days`
- Issues that a merged pull request or the code seems to have fixed already, and issues that look like duplicates, both checked by Claude against the code
- Labels that fit the issues without any, which it adds with `labels: true`
- Issues without labels, and issues quiet for `stale-days`

It closes nothing and comments nowhere else. Medium effort, up to 40 turns and $5.

## Safety

The actions are built to run on pull requests and issues from anyone, once a maintainer allows it.

- **Nothing from the repository runs.**
  - Claude Code loads no settings, hooks or MCP servers from the checkout (`--setting-sources user`, `--strict-mcp-config`, hooks off).
  - The review gets `Read`, `Glob`, `Grep`, the inline-comment tool, and the exact `gh` commands the review needs. Describe, triage, ask and housekeeping get `Read`, `Glob` and `Grep`, and fix also `Edit` and `Write`. None can run any other command, browse the web or start sub-agents, and none can read `/proc` or `/sys`, where the process's secrets are.
  - Checkouts keep no token, and no step runs a file from the workspace.
- **Claude answers; the action acts.** Apart from the review, Claude has no GitHub tools: it answers in a fixed shape, and the steps after it decide what of that answer reaches the repository. They write only what the configuration turned on, add only labels the repository has, name only issues and files that exist, and edit only rivi-bot's own comments and its own section of a description. Nothing is closed, and no label is taken off.
- **Fix in two jobs.** Claude edits a checkout in a job with a read-only token. A second job, which never runs Claude, checks the patch, commits it and pushes. Whatever the first job leaves on its runner cannot reach the token that pushes. The second job pushes nothing under `.github/`, and the first refuses a patch with the API key in it.
- **One commit.** The review reads `head-sha`, the commit the maintainer approved, and nothing pushed after it.
- **Prompt injection.** Claude is told that what the pull request or issue contains is material, never instructions. Text in a pull request can still steer what a review says, so a review approves only a pull request by someone with write access, and only with `approve`. A fix takes in comments only from rivi-bot and people with write access.
- **The gate.** On `pull_request_target`, `issues` and `issue_comment`, a workflow has your secrets for content from anyone. The reusable workflow reviews an outside pull request only after a maintainer adds the label or gives the command, takes commands only from people with write access, and reads its configuration from the default branch. If you run an action yourself, run it on an outside pull request only after a maintainer approves (a label, as below, or an environment with required reviewers), never as soon as it opens. An approval can be good for one review, or stand until a maintainer takes it back, so that later pushes are reviewed too. A standing approval means each push spends up to a follow-up's budget on code nobody has read yet.

## The actions on their own

To pin an action, choose its other inputs, or decide yourself when it runs, use the actions in a workflow of your own:

| Action | What |
| --- | --- |
| `rivi-software/tools/rivi-bot` | [The review](#review) |
| `rivi-software/tools/rivi-bot/describe` | [Describe](#describe) |
| `rivi-software/tools/rivi-bot/triage` | [Triage](#triage) |
| `rivi-software/tools/rivi-bot/fix` and `rivi-bot/fix/push` | [Fix](#fix), in two jobs: `fix` with read access, then `fix/push` with its outputs and write access |
| `rivi-software/tools/rivi-bot/ask` | [Ask](#ask) |
| `rivi-software/tools/rivi-bot/housekeeping` | [Housekeeping](#housekeeping) |

Each takes `anthropic-api-key`, `github-token` (`github.token` by default) and `model`, and its feature's settings from [the configuration](#configuration) as inputs of the same names; `action.yml` in its directory documents the rest. With an App, pass its installation token as `github-token`, and `<app-slug>[bot]` as `reviewer` or `login`.

This workflow reviews a pull request once each time a maintainer adds the label:

```yaml
name: review
on:
  pull_request_target:
    types: [labeled]
permissions: {}
jobs:
  review:
    if: github.event.label.name == 'rivi-bot:review'
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    concurrency:
      group: review-${{ github.event.pull_request.number }}
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Check the approval
        env:
          GH_TOKEN: ${{ github.token }}
          SENDER: ${{ github.event.sender.login }}
        run: |
          permission=$(gh api "repos/$GITHUB_REPOSITORY/collaborators/$SENDER/permission" --jq .permission)
          case "$permission" in admin | maintain | write) ;; *) exit 1 ;; esac
      - uses: rivi-software/tools/rivi-bot@<commit sha> # or a rivi-bot-v* tag
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_REVIEW_API_KEY }}
          pull-request: ${{ github.event.pull_request.number }}
          head-sha: ${{ github.event.pull_request.head.sha }}
      - name: Take the label off
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: gh api --method DELETE "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/labels/rivi-bot%3Areview" || true
```

Taking the label off makes each approval good for one review: a later push needs a new one.

### Review inputs

| Input | Default | What |
| --- | --- | --- |
| `anthropic-api-key` | (required) | The key Claude runs on |
| `github-token` | `github.token` | Posts the review and fetches the history for a follow-up; needs contents read and pull-requests write |
| `pull-request` | the event's pull request | The pull request to review |
| `head-sha` | the event's head | The commit to review, normally the one a maintainer approved |
| `reviewer` | `github-actions[bot]` | The login `github-token` posts as; a follow-up review starts from this login's last review |
| `follow-up` | `true` | `false` reviews the whole pull request every time |
| `approve` | `false` | `true` lets Claude approve when nothing has to change, and dismisses the reviewer's earlier approvals before a review of a later commit |
| `focus` | | What else your reviews look for |
| `instructions` | | Instructions for this one review, which may narrow or steer it |
| `model` | `claude-opus-5-5` | The Claude model |

The output `reviewed` is `true` when a review was posted.

The actions run on GitHub's Linux runners, which come with `gh`, `jq`, `yq` and `git`. They use [Claude Code's GitHub Action](https://github.com/anthropics/claude-code-action), pinned to a commit.

## Versions

Pin the actions or the reusable workflow to a commit SHA, or to a `rivi-bot-v*` tag cut from `main`. They are versioned by tag, not published to npm. The reusable workflow runs the actions from `main` at any ref: pin the actions themselves to fix their version.

## License

[MIT](../LICENSE)
