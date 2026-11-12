---
name: recreate-fork-pr
description: Recreates a pull request from a fork in rivi-software/tools as a `fork/<number>` branch and pull request with the contributor's commits unchanged, so CI runs on Depot CI. Use when asked to recreate, copy or sync a fork's pull request, or when a fork's pull request has no `CI / verify` check.
---

# Recreate a pull request from a fork

"Recreating a pull request from a fork" in `CONTRIBUTING.md` is the procedure: read it first. Depot CI does not run pull requests from forks, so the copy is where CI runs and the one that merges. The push runs code from outside the team with this repository's trust, so every step before it makes sure someone read exactly the commit that gets pushed.

## 1. Read the pull request

```bash
gh pr view <n> --json number,title,body,author,isCrossRepository,isDraft,state,headRefOid,maintainerCanModify
gh pr diff <n>
git ls-remote origin "refs/heads/fork/<n>"
```

- `isCrossRepository` is false, or `state` is not `OPEN`: tell the user, who decides.
- `fork/<n>` exists: the copy is open already, so this is a later push. Go to [Copy a later push](#copy-a-later-push).

Read the whole diff, every changed file, as a reviewer who expects an attack. Done when you can say what each changed file does, and have a list of every change to `.depot/`, `.github/`, `scripts/`, the `scripts` of a `package.json`, `pnpm-workspace.yaml`, and each package `pnpm-lock.yaml` adds or resolves from a new URL, with what it does. Code that runs at install, in a test or in CI and does more than the pull request says, such as a network call, a read of the environment, a write outside the checkout, an obfuscated line or a binary, is a finding: it goes to the user in step 2.

## 2. Confirm

The push is the user's call. Show them the `headRefOid` you read, the list from step 1 and every finding, and wait for a yes for this pull request.

## 3. Push the commit you read

```bash
git fetch origin "pull/<n>/head"
git rev-parse FETCH_HEAD
git push origin "<headRefOid>:refs/heads/fork/<n>"
```

`FETCH_HEAD` is the `headRefOid` from step 1 before anything is pushed. When it differs, the contributor pushed after you read: read the new commits as in [Copy a later push](#copy-a-later-push), and confirm again.

## 4. Open the copy

Load the `house-style` skill. The copy takes the original's title; when that is not a Conventional Commits title, write one by the rule in the `create-pr` skill. The body is the original's, as it is, under one first line. Its `Closes #<issue>` lines then close the issue when the copy merges. The mention notifies the contributor, which is intended: `author.login` from step 1 is the checked handle.

```bash
gh pr create --base main --head "fork/<n>" --title "<title>" --body-file - <<'EOF'
Recreates #<n> by @<author.login>, with their commits unchanged, so CI runs on Depot CI. The conversation stays on #<n>.

<the original's body>
EOF
```

Add `--draft` when the original is a draft. Then tell the contributor, on the original:

```bash
gh pr comment <n> --body-file - <<'EOF'
CI runs on Depot CI, which does not run pull requests from forks yet. #<copy> carries your commits, unchanged, from a branch here: CI runs there, and #<copy> is the one that merges, with you as a co-author. Keep pushing here, and keep the conversation here: a maintainer copies each push over once they have read it.
EOF
```

Done when the copy is open from `fork/<n>` at the `headRefOid` you read, the original has the comment, and the user has both links. Approving and merging the copy, then closing the original, are the code owner's: step 5 in `CONTRIBUTING.md`.

## Copy a later push

```bash
git fetch origin main "pull/<n>/head"
git ls-remote origin "refs/heads/fork/<n>" # the old SHA
gh pr view <n> --json headRefOid           # the new SHA
gh pr list --head "fork/<n>" --json number # the copy
git range-diff origin/main <old sha> <new sha>
```

`range-diff` shows each commit's change, a rebase included. Read it as in step 1, with the same list and findings, and confirm as in step 2. Then push the new head over the copy:

```bash
git push --force-with-lease="refs/heads/fork/<n>:<old sha>" origin "<new sha>:refs/heads/fork/<n>"
```

When the original's body changed, carry the change over to the copy's (`gh pr edit <copy> --body-file -`), with the first line kept. Done when `fork/<n>` is at the new SHA you read.
