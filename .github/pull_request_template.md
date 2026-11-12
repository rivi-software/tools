<!--
This description has to stand on its own: a reader who opens no files should still know why the pull request is needed and what it does. Aim for 200 words or fewer, table cells included. Code blocks, diagrams and <details> blocks do not count. A section with nothing to say gets one bullet: "- None."

Title: Conventional Commits, with the package's directory as the scope: fix(workers-mail): …, feat(deploy-watch): …. rivi-bot takes the rivi-bot scope; work across the repository takes none: ci: …, docs: …, chore: …. Lowercase, no period, under 72 characters. Pull requests are squash-merged, so the title becomes the commit on main.

CONTRIBUTING.md has what a pull request needs: https://github.com/rivi-software/tools/blob/main/CONTRIBUTING.md#your-pull-request
-->

## Problem

<!-- Who is this for, what do they need, and why does it matter? -->
<!-- First line: who is affected and what is wrong for them today. A fix says what breaks, and where; a feature names the goal and what stands in the way; a chore says who or what is blocked. It must stay true under a different solution: the code path goes under Changes. Take the need from the issue, and say so when there is none. -->

<!-- Does this close an issue? Uncomment the line below with its number, and GitHub closes it on merge. -->
<!-- Closes #123 -->

## Changes

<!-- For each change that someone using the package can notice, say what they now see or do differently, not only the code path behind it: a new option, a changed default, an error that reads differently. Mark the rest as mechanical, so a reviewer knows nothing they would notice hides in it. -->
<!-- When the change rewires a flow, such as a function's steps, a workflow's jobs or a file tree, show it before and after in one ```diff block. Say why this design beats the obvious alternative. -->
<!-- Name each new export, new runtime dependency and changed default. The package's README changes with what it does or exports. -->

## How did you test this code?

<!-- Describe how to reproduce the problem and check the fix, and what happens before and after. -->
<!-- Changed behaviour comes with a Vitest test in the package's tests/. A bug fix comes with a test that fails without the fix. -->
<!-- For each group of added or changed tests, name the regression it catches and the closest existing test you checked. If no new test is needed, name the coverage that already exists, or say why a test would not help. -->

**Test rationale:** [The regression and the closest existing test, or why no new test is needed.]

<!-- CI runs `pnpm run verify` on Node 22, 24 and 26: don't recite its pass counts. Name what you ran beyond it, link the evidence (a workflow run, a permalink), and say what you did not check, such as a workflow that only runs from main once merged. Long output goes in a <details> block. -->
<!-- Agents: do NOT claim manual testing you have not done. List only the commands you actually ran, and say what you could not do. -->

## Release

<!-- Keep exactly one line and delete the others. Plain bullets, not checkboxes: GitHub counts every checkbox in the body as an open task. -->

- Changeset: `patch` for `@rivi-software/<name>` (a fix)
- Changeset: `minor` for `@rivi-software/<name>` (a feature)
- Changeset, bump unsure: a maintainer settles it
- No changeset: tests, CI, rivi-bot or the repository's own docs only

## Merge Danger

<!-- Two-way when a revert undoes the change. One-way when it cannot: a published version, a removed or renamed export, data written, a ruleset applied. Say what a revert undoes and what it leaves behind. -->

**Door:** two-way - or - one-way

<!-- Who gets this, and when, in a word or two (opt-in, one package's callers, releases, every rivi-bot run, repo-wide), then what happens to them if it is wrong. -->

**Blast Radius:** [scope]

<!-- "needed" when the pull request touches a workflow (pull_request_target above all), scripts/, a package.json's scripts, pnpm-workspace.yaml, a token or a secret, a new runtime dependency, or what rivi-bot reads or runs. Then say what to read closely. Otherwise "not needed". -->

**Security review:** needed - or - not needed

## 🤖 Agent context

<!-- Fill this in when an agent wrote part or all of the pull request, and delete it when a person wrote all of it. Whoever opens it is its author all the same (CONTRIBUTING.md, "AI tools"). -->

<!-- Keep one: "Human-driven (agent-assisted)" when a person directed the work, "Fully autonomous" when no person did. -->

**Autonomy:** Human-driven (agent-assisted) - or - Fully autonomous

<!-- The tool and the exact model, e.g. "Claude Code, Opus 5.5". List each model that wrote code. -->

**Agent:** tool, model

<!-- Every skill or slash command that shaped the code, e.g. /simplify, /code-review. "None" when none ran. -->

**Skills:** `/skill`

<details>
<summary>More context for AI agents</summary>

<!-- Agents: this block is collapsed and does not count toward the 200 words.
     Keep it current: on every push, rewrite it to describe the pull request at that commit. Replace stale bullets; never append a log.
     One line per bullet, under 25 words, 10 bullets at most. Delete a field with nothing in it.
     This is the ONLY place that may describe what the pull request looked like before. Don't repeat facts from the sections above.
     Paraphrase what the person asked for; never paste their prompts. Leave out tool output and anything private from the session. -->

- **Session:** the tools used
- **Decisions:** one bullet per decision that changed during the work
- **Follow-ups:** work left for a later pull request
- **Read closely:** the files or lines that need a careful review

</details>

<!--
Rules for agents that write this description:
- Title: as above. ✅ fix(deploy-watch): keep the notice after a dismissal  ❌ Fix: Fixed the notice.  (capitalized, period, no scope)
- Voice: the subject of each sentence is the change, never its author. No "I", "me" or "my": the person who opens the pull request did not run what the agent ran. Who wrote it is one fact, in Agent context.
- Body: pass it straight to `gh pr create --body-file -` on stdin, so the markdown and line breaks survive. Don't write it to a temporary file first.
- Shape: lead Problem with who is affected, taken from a source and true under any fix. Lead Changes with what a person notices, not the code path. Link evidence instead of repeating what CI reports. One fact per bullet, under 25 words. A body that grew into more bullets was not cut.
- One change per pull request, to one package where it can. When the diff holds steps that stand apart (a rename, then a rewrite), or the body needs more than 200 words, suggest splitting it to the person who directed the work.
- Draft: open as a draft until `pnpm run verify` passes locally. rivi-bot skips drafts, reviews a maintainer's pull request once it leaves draft, and each review spends its budget.
- rivi-bot describe adds its own summary at the end of this description, between `rivi-bot:summary` markers. Leave them as they are.
- Public repository: no secrets, tokens, private repositories, customer data or internal incidents, in code, fixtures, commit messages or this description.
- Never write an @mention you have not checked this session (`gh api user`, `gh pr view --json author,assignees`). Never infer a handle from a display name.
- Do NOT claim manual testing you have not done. Don't add a person's Co-authored-by only for attribution.
- Agent-written pull requests need a person's review. The code owner approves before merge; never self-merge or approve.
-->
