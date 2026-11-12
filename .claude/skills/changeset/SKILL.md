---
name: changeset
description: Writes the changeset for a change to a published @rivi-software package, with its bump and a changelog entry for the people who use the package. Use when a pull request needs a changeset, or when asked to add or fix one.
---

# Write a changeset

`pnpm changeset` is interactive, so write the file directly.

## Does the change need one?

- **Yes:** anything a published package ships to npm: its `src/`, its `package.json` (exports, dependencies, peer ranges) or its README, which npm shows only from a release.
- **No:** tests only, CI, `scripts/`, the repository's own docs, and rivi-bot, which is versioned by tags (the `release-rivi-bot` skill). A new package needs none either: its first version is the one in its `package.json`.

## The file

`.changeset/<short-kebab-summary>.md`, named for the change, such as `redact-worker-exception-text.md`:

```markdown
---
"@rivi-software/<name>": patch
---

The entry.
```

- `patch` for a fix, including a README or doc comment change. `minor` for a feature: a new export, option or behaviour.
- Every package is below 1.0, so a breaking change is the maintainer's call. Write the bump that fits best, and pick the template's "bump unsure" line in the pull request, saying what breaks.
- One file lists several packages when one entry fits them all; otherwise each package gets its own file.

## The entry

It becomes the package's `CHANGELOG.md` entry and its GitHub release, read by people who use the package. Load the `house-style` skill, then:

1. Lead with what the package does now, in the present tense, naming the export or option: "The Worker now sends an exception with its secret paths (`setSecretPaths`) as their pattern…".
2. Then "Before, …": what went wrong and for whom, with the smallest example.
3. Then what a user has to do, if anything, to get the change or keep the old behaviour.

What a user cannot notice stays out, and so do the pull request and the issue: the changelog adds the commit. `packages/deploy-watch/CHANGELOG.md` has entries of every length.

## Check

`pnpm exec changeset status --since=origin/main` lists the packages the branch's changesets release, and fails when a package changed without one. A package whose only change is its tests shows up there too and still needs none.
