# @rivi-software/workers-previews

## 1.0.1

### Patch Changes

- 36f3490: `sweepPreviews`, and `cf-previews sweep --apply`, now read the Worker's Workers Builds once and check every stale branch against that list. They read the builds again whenever the list is 30 seconds old, so a build that starts during a long sweep still stops its branch's delete, and before they refuse a delete, so a build that finished since the read holds nothing up. Before, the sweep read the whole build history once per branch it deleted: 60 stale branches and 3,000 builds took about 900 requests to the Builds API, and a rate limit there failed deletes and made the sweep exit with `1`. `delete` and `deleteBranchPreviews` still read the builds each time.

## 1.0.0

### Major Changes

- e686453: The package is now at 1.0.0, and its releases follow semantic versioning: a breaking change raises the major version. Nothing in the package changes in this release. Before, its 0.x versions could break in a minor release. A range such as `^0.4.0` does not pick up 1.0.0, so change it to `^1.0.0` to get this and later releases.

### Patch Changes

- Updated dependencies [e686453]
  - @rivi-software/cloudflare-deploy@1.0.0

## 0.1.4

### Patch Changes

- 3dcab94: `sweepPreviews`, `previewInventory` and `cf-previews sweep` and `list` now list the Worker's Previews first and read the repository after, so a Preview deployed while the sweep runs is never taken for a deleted branch's. Before, they read both at once. When the repository read finished first, a Preview that `cf-previews deploy` made in GitHub Actions for a branch pushed meanwhile had no branch in it, and `sweep --apply` deleted it as "no live branch or pull request has this name". The same held for the `pr-<number>` Preview of a pull request opened meanwhile. A `repository` function passed to `sweepPreviews` is now called after the Previews are listed.

## 0.1.3

### Patch Changes

- Updated dependencies [a67af4c]
  - @rivi-software/cloudflare-deploy@0.4.0

## 0.1.2

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.
- Updated dependencies [5fcdab0]
  - @rivi-software/cloudflare-deploy@0.3.1

## 0.1.1

### Patch Changes

- 4b3cc5c: Add doc comments to the `PreviewNameOptions`, `SweepOptions`, `SweepResult`, `GitHubRepositoryOptions` and `DeployPreviewOptions` types, and to `SweepResult`'s `entries` and `targets` and `DeployPreviewOptions`' `branch`, so an editor shows them. This is the first version the release workflow publishes, with npm provenance; 0.1.0 was published by hand.
