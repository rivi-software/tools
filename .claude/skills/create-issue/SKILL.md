---
name: create-issue
description: Files an issue in rivi-software/tools in the repository's own shape (scoped title, issue type, scope label, What happens / What should happen / Done when). Use when asked to open, file or draft an issue, a bug report or a follow-up for this repository.
---

# Create an issue

An issue here is a spec a person or an agent can pick up cold: `gh issue view 111`, `126` and `133` show the shape. Load the `house-style` skill first.

## 1. Check it belongs in a public issue

- A vulnerability goes in a private report, never an issue: `SECURITY.md` names the two routes. Tell the user and stop.
- Search for an existing issue: `gh issue list --state all --search "<words>"`. When one covers it, give the user its link instead.
- One issue is one change, the size of one pull request. Two changes are two issues.

## 2. Investigate

Read the code the issue is about at `origin/main`, and the README section that promises the behaviour. Confirm each fact before it goes in: the `path:line`, what the code does today, what the README says. When behaviour is in doubt, run it or write a quick test. What could not be confirmed goes in as an open question, marked as one.

Done when every sentence under What happens is something checked this session.

## 3. Write it

**Title:** `<scope>: <the outcome wanted>`, lowercase, no period. The scope is the package's directory (`workers-mail`), `rivi-bot`, or `repo` for CI, releases, scripts and repository-wide docs. Examples: `workers-bundle-check: check symlinked files in the assets directory, which Wrangler serves`; `repo: add timeouts to CI and release jobs`.

**Type** (`--type`):

- `Bug`: the code does not do what its README says.
- `Feature`: new behaviour, or a change people using the package notice.
- `Task`: a chore, refactor, docs, CI or tooling change nobody using the package notices.

**Labels:** `scope:<scope>` for each scope it touches. A topic label when it plainly fits: `security`, `performance`, `documentation`, `accessibility`, `question`. The maintainer labels (`breaking-change`, `good first issue`, `help wanted`, `ready-for-agent`, `ready-for-human`) go on when the user asks for them. Workflows add `needs-triage`, the project card and its Priority and Effort fields.

**Body:**

```markdown
## What happens

Today's behaviour, and who it hurts. Cite `path:line`, quote the README where it promises otherwise, and show the smallest example. For a bug hit in an app: the package and version, where it runs (Node, a Worker, the browser, with the versions of what it plugs into) and the steps to reproduce it.

## What should happen

The behaviour wanted, and the constraints any fix must respect. Where there is a real choice of approach, name the options; the pull request settles the design.

## Done when

- The test that proves it, and for a bug, one that fails today.
- The README section that changes, when what the package does or exports changes.
- A changeset for a patch or minor release, when a published package changes.
```

Every "Done when" bullet is checkable from a diff.

## 4. File it

When the user asked for the issue, file it. When it is your own idea, such as a follow-up found during other work, show the title and body and wait for a yes: an issue is public once filed.

```bash
gh issue create --title "<title>" --type <Type> --label "scope:<scope>" --body-file - <<'EOF'
<body>
EOF
```

Give the user the link. The issue reaches the RIVI Open Source project on its own within half an hour.
