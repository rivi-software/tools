---
"@rivi-software/workers-previews": patch
---

`sweepPreviews`, and `cf-previews sweep --apply`, now read the Worker's Workers Builds once and check every stale branch against that list. They read the builds again once the list is 30 seconds old, so a build that starts during a long sweep still stops its branch's delete. Before, the sweep read the whole build history once per branch it deleted: 60 stale branches and 3,000 builds took about 900 requests to the Builds API, and a rate limit there failed deletes and made the sweep exit with `1`. `delete` and `deleteBranchPreviews` still read the builds each time.
