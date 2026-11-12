---
name: release-rivi-bot
description: Cut a rivi-bot-v* release, choosing the commit and the version and drafting the notes, and create the tag and GitHub release after a yes.
disable-model-invocation: true
---

# Cut a rivi-bot release

"A rivi-bot release" in `CONTRIBUTING.md` is the procedure: read it first. A release tag is created once and never moved or deleted (`.github/rulesets/release-tags.json`), so every step before the last one is there to get the commit, the version and the notes right.

1. **The commit.** `git fetch origin main --tags`. The target is the head of `origin/main`, unless the user names an earlier commit. Its `verify` check passed:

   ```bash
   gh api repos/rivi-software/tools/commits/<sha>/check-runs --jq '.check_runs[] | "\(.name) \(.status) \(.conclusion)"'
   ```

   Still running or failed: stop and tell the user.

2. **What changed.** Run the `git log` from `CONTRIBUTING.md` to list the commits since the last `rivi-bot-v*` tag, then read each one's pull request (`gh pr view <n>`), not only its title. An empty list means there is nothing to release.

3. **The version.** Major, minor or patch, by the rules in `CONTRIBUTING.md`; the highest bump any change needs wins. A security fix names its advisory (`gh api repos/rivi-software/tools/security-advisories --jq '.[] | "\(.ghsa_id) \(.state) \(.summary)"'`), and the advisory names this version as patched.

4. **The notes.** For the people who run rivi-bot. `gh release view rivi-bot-v1.0.0` and the last release show the shape: a first line that says how to pin it, by tag and by commit SHA, then the headings that apply: Security, Changes, Upgrading. Load the `house-style` skill.

5. **Confirm.** Show the user the commit, the version and the notes, and wait for a yes.

6. **Release.**

   ```bash
   gh release create rivi-bot-v<version> --target <sha> --title rivi-bot-v<version> --notes-file - <<'EOF'
   <notes>
   EOF
   ```

   Give the user the link.
