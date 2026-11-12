---
name: create-pr
description: Opens or updates a pull request in rivi-software/tools the way CONTRIBUTING.md asks, with one change per branch, tests, a changeset, `pnpm run verify`, a Conventional Commits title and a body from the pull request template. Use when asked to open, create, update or describe a pull request for this repository.
---

# Create a pull request

`CONTRIBUTING.md` ("Your pull request") and `.github/pull_request_template.md` are the source of truth. This is the order to work through them.

## 1. Shape the branch

```bash
git fetch origin main
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

- One pull request makes one change, to one package where it can. When the diff holds changes that stand apart, such as a rename and a rewrite, or two unrelated fixes, propose the split to the user before going on.
- On `main`, create a branch named `<type>/<short-kebab-summary>`, its type the same as the title's: `fix/semgrep-escape-finding-text`, `docs/rivi-bot-release-tags`. `main` takes changes only through pull requests.
- Commit messages follow Conventional Commits. The pull request is squash-merged, so its title becomes the commit on `main`.

## 2. Complete the change

From "Making the change" in `CONTRIBUTING.md`:

- Changed behaviour has a Vitest test in the package's `tests/`. A bug fix has one that fails without the fix.
- The package's README changes with what the package does or exports.
- A change to a published package has a changeset: load the `changeset` skill.
- A new runtime dependency has a maintainer's agreement in an issue. Without one, stop and ask the user.

## 3. Verify

`pnpm install`, then `pnpm run verify`, which runs what CI runs. Fix what fails and run it again. When it cannot pass, the pull request opens as a draft and its body says what fails.

## 4. Write the title and body

**Title:** `<type>(<scope>): <summary>`. The scope is the package's directory or `rivi-bot`; work across the repository takes none (`ci: …`, `docs: …`, `chore: …`). Types in use: `feat`, `fix`, `docs`, `test`, `ci`, `chore`. Lowercase, no period, under 72 characters, saying what changes for the person who uses it: `fix(deploy-watch): keep the notice after a dismissal`.

**Body:** load the `house-style` skill, read `.github/pull_request_template.md`, and fill each section by the comments in it, including the rules for agents at its end. `gh pr view 131` is a filled-in example. On top of the template:

- The comments come out and the headings stay. Exactly one Release line, and one value each for Door, Security review and Autonomy.
- Problem comes from a source: the issue it closes (`Closes #<n>`), or what the user asked for.
- "How did you test this code?" lists only what ran this session.
- Agent is `Claude Code, <exact model>`. Skills lists each skill or slash command that shaped the code.
- Count the words outside code blocks and the `<details>` block, and cut to 200 or fewer.

## 5. Open it

When the user asked for the pull request, open it. Otherwise show the title and body and wait for a yes.

```bash
git push -u origin HEAD
gh pr create --base main --title "<title>" --body-file - <<'EOF'
<body>
EOF
```

- Add `--draft` when `verify` fails locally, or when the user wants feedback first. rivi-bot reviews a maintainer's pull request as soon as it is ready for review, and each review spends its budget.
- The labeler adds the `scope:*` labels. `rivi-bot:review` is a maintainer's call.
- The code owner approves and merges. Approving or merging is theirs alone.

Give the user the link.

## Updating a pull request

After each later push, read the body (`gh pr view <n> --json body --jq .body`) and rewrite what the push changed: Changes, "How did you test this code?", Release, Merge Danger, and the "More context for AI agents" block, which describes the pull request at the new commit (replace its bullets, never append). Keep the `rivi-bot:summary` markers and what sits between them as they are. Send it back with `gh pr edit <n> --body-file -`.
