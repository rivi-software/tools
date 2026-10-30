# rivi-bot

A pull request review by Claude, as a GitHub Action. A maintainer asks for a review, and Claude reads the pull request at that one commit, with read-only tools. It then posts one review: an inline comment for each finding and a short summary, pinned to the commit it read. A later review of the same pull request reads only what changed since.

RIVI Software runs it as RIVI Bot on its own repositories, this one included ([the workflow](../.github/workflows/rivi-bot.yml)). A pull request by someone with write access is reviewed when it opens and after every push, and may be approved. Any other pull request is reviewed once a maintainer adds the `rivi-bot:review` label, and after every push while the label stays on. Those reviews only comment.

## What the review does

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
- **What it writes.** One inline comment per finding, with a suggestion block when the fix is a few lines it is sure of. Then exactly one review on the commit it read: a short body with the findings that need a change, one line each. The review comments; it approves only with `approve: true`. It never requests changes and never posts a plain comment.
- **Approvals.** With `approve: true`, an approval stands for the commit it read. Before a review of a later commit, the reviewer's earlier approvals on the pull request are dismissed, and the new review approves again if nothing has to change.
- **Follow-up reviews.** After an earlier review by the same login, it reads only what changed since the commit that review read. It replays that commit's changes onto the pull request's current fork point (`git merge-tree`), so a rebase onto the base, or a merge of it, is not reviewed again. If nothing changed but the base, there is no review.
- **Budget.**
  - A whole pull request runs at high effort, with up to 40 turns and $10.
  - A follow-up runs at medium effort, with up to 20 turns and $3.
  - The API key's workspace spend limit is the hard cap.

## Safety

The action is built to review pull requests from anyone, once a maintainer approves.

- **Nothing from the pull request runs.**
  - Claude Code gets `Read`, `Glob`, `Grep`, the inline-comment tool, and the exact `gh` commands the review needs. It cannot edit, write, browse the web, start sub-agents, or run any other command.
  - It loads no settings, hooks or MCP servers from the checkout (`--setting-sources user`, `--strict-mcp-config`, hooks off).
  - The checkout keeps no token.
  - No step of the action runs a file from the workspace.
- **One commit.** The review reads `head-sha`, the commit the maintainer approved, and nothing pushed after it.
- **Prompt injection.** Claude is told that what the pull request contains is material under review, never instructions. Text in a pull request can still steer what a review says, so the review comments rather than approves unless you set `approve: true`.
- **The gate is yours.** On `pull_request_target`, a workflow has your secrets for pull requests from forks. Run the action on an outside pull request only after a maintainer approves (a label, as below, or an environment with required reviewers), never as soon as it opens. An approval can be good for one review, or stand until a maintainer takes it back, so that later pushes are reviewed too. A standing approval means each push spends up to a follow-up's budget on code nobody has read yet, so keep `approve` off for those pull requests.

## Setup

1. Add an Anthropic API key as an Actions secret, such as `ANTHROPIC_REVIEW_API_KEY`. Use a key from a workspace with a spend limit.
2. Create the label that approves a review, such as `rivi-bot:review`. Adding a label needs triage access; the workflow below also checks for write access.
3. Optionally, use a GitHub App with **Contents: read** and **Pull requests: write**, installed on the repository, so the reviews come from the App instead of `github-actions`. Pass its installation token as `github-token`, and `<app-slug>[bot]` as `reviewer`.
4. Add the workflow:

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

Taking the label off makes each approval good for one review: a later push needs a new one. [This repository's workflow](../.github/workflows/rivi-bot.yml) goes further. It leaves the label on and also runs on `synchronize`, so later pushes are reviewed too. It reviews pull requests from people with write access without a label, and lets only those reviews approve.

## Inputs

| Input | Default | What |
| --- | --- | --- |
| `anthropic-api-key` | (required) | The key Claude runs on |
| `github-token` | `github.token` | Posts the review and fetches the history for a follow-up; needs contents read and pull-requests write |
| `pull-request` | the event's pull request | The pull request to review |
| `head-sha` | the event's head | The commit to review, normally the one a maintainer approved |
| `reviewer` | `github-actions[bot]` | The login `github-token` posts as; a follow-up review starts from this login's last review |
| `follow-up` | `true` | `false` reviews the whole pull request every time |
| `approve` | `false` | `true` lets Claude approve when nothing has to change, and dismisses the reviewer's earlier approvals before a review of a later commit |
| `focus` | | What else your reviews look for, in a sentence or two |
| `instructions` | | Instructions for this one review, which may narrow or steer it |
| `model` | `claude-opus-5-5` | The Claude model |

The output `reviewed` is `true` when a review was posted.

The action runs on GitHub's Linux runners, which come with `gh`, `jq` and `git`. It uses [Claude Code's GitHub Action](https://github.com/anthropics/claude-code-action), pinned to a commit.

## Versions

Pin the action to a commit SHA, or to a `rivi-bot-v*` tag cut from `main`. It is versioned by tag, not published to npm.

## License

[MIT](../LICENSE)
