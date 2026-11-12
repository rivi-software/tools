---
name: work-on-issue
description: Takes a rivi-software/tools issue from reading to an open pull request, with its "Done when" list as the finish line. Use when asked to work on, fix, implement or pick up an issue by number or link.
---

# Work on an issue

## 1. Read it

`gh issue view <n> --comments`, then every issue and pull request it links, and `gh pr list --state open --search "<n>"` for a pull request already on it.

Stop and ask the user before going on when:

- an open pull request already closes it, or someone said in it that they are on it;
- it carries `needs-info`, `ready-for-human`, `duplicate` or `wontfix`;
- it asks for a feature, a change to what a package exports or a new dependency, and nobody from the team agreed to the approach in it;
- it has no "Done when", or one too vague to check from a diff. Propose the bullets and agree on them.

## 2. Confirm the problem

The issue may be stale. Check what "What happens" says against the code at `origin/main`. For a bug, write the test that shows it and watch it fail for the reason the issue gives: that test is the first part of the fix. When the code no longer does what the issue says, tell the user and stop.

## 3. Branch

```bash
git fetch origin main
git switch -c <type>/<short-kebab-summary> origin/main
```

The type matches the pull request's title: `fix`, `feat`, `docs`, `test`, `ci` or `chore`.

## 4. Make the change

Work until every "Done when" bullet holds, each one pointing at something in the diff: a test, a README section, a changeset file. Follow "Making the change" in `CONTRIBUTING.md`, and load the `changeset` skill for the changeset.

- Where "What should happen" offers options, pick one and record why in the pull request's Decisions.
- The change stays within the issue. Anything else found on the way goes in the pull request's Follow-ups, or into its own issue when the user asks (the `create-issue` skill).

## 5. Open the pull request

Load the `create-pr` skill. The body closes the issue (`Closes #<n>`) and takes its Problem from the issue.

Done when the pull request is open and each "Done when" bullet maps to a line of its diff.
