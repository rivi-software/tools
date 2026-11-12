---
"@rivi-software/workers-previews": patch
---

`sweepPreviews`, `previewInventory` and `cf-previews sweep` and `list` now list the Worker's Previews first and read the repository after, so a Preview deployed while the sweep runs is never taken for a deleted branch's. Before, they read both at once. When the repository read finished first, a Preview that `cf-previews deploy` made in GitHub Actions for a branch pushed meanwhile had no branch in it, and `sweep --apply` deleted it as "no live branch or pull request has this name". The same held for the `pr-<number>` Preview of a pull request opened meanwhile. A `repository` function passed to `sweepPreviews` is now called after the Previews are listed.
