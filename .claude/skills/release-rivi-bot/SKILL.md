---
name: release-rivi-bot
description: Cut a rivi-bot-v* release through the rivi-bot release workflow, choosing the commit and the version and rewriting the draft's notes, and publish it after a yes.
disable-model-invocation: true
---

# Cut a rivi-bot release

"A rivi-bot release" in `CONTRIBUTING.md` is the procedure: read it first. The rivi-bot release workflow (`.github/workflows/rivi-bot-release.yml`) checks the commit and drafts the release; publishing the draft creates the tag. A release tag is created once and never moved or deleted (`.github/rulesets/release-tags.json`), so every step before the last one is there to get the commit, the version and the notes right.

1. **The plan.** See what the workflow would draft, without drafting it:

   ```bash
   git fetch origin main --tags
   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=rivi-software/tools BUMP=auto node scripts/release-rivi-bot.ts --dry-run
   ```

   Set `COMMIT=<sha>` when the user names a commit other than the head of `main`. An error, such as CI still running or failed, nothing to release, or a draft that waits: stop and tell the user.

2. **What changed.** Read the pull request of each commit the plan lists (`gh pr view <n>`), not only its title.

3. **The version.** The plan's version follows the titles: major for a `!`, minor for a `feat`, patch for the rest. Check it against the rules in `CONTRIBUTING.md`, which the pull requests may contradict; the highest bump any change needs wins. A security fix names its advisory (`gh api repos/rivi-software/tools/security-advisories --jq '.[] | "\(.ghsa_id) \(.state) \(.summary)"'`), and the advisory names this version as patched.

4. **The draft.** Run the workflow with `auto`, or with the part the titles get wrong:

   ```bash
   gh workflow run rivi-bot-release.yml --ref main -f bump=<auto|major|minor|patch> [-f commit=<sha>]
   gh run list --workflow rivi-bot-release.yml --limit 1
   ```

   When the run fails, `gh run view <id> --log-failed` says why.

5. **The notes.** For the people who run rivi-bot. The draft lists the commits; rewrite them. `gh release view rivi-bot-v1.0.0` and the last release show the shape: a first line that says how to pin it, by tag and by commit SHA (the draft has it), then the headings that apply: Security, Changes, Upgrading. Load the `house-style` skill.

   ```bash
   gh release edit rivi-bot-v<version> --notes-file - <<'EOF'
   <notes>
   EOF
   ```

6. **Confirm.** Show the user the commit, the version and the notes, and wait for a yes.

7. **Release.** `gh release edit rivi-bot-v<version> --draft=false`, which creates the tag. Give the user the link.
