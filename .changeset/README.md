# Changesets

A change to a published package comes with a changeset, which names the packages it releases, the semver bump and the line for their changelogs:

```bash
pnpm changeset
```

The release workflow keeps a "Version packages" pull request open while changesets wait on `main`; merging it publishes the new versions to npm. See [CONTRIBUTING.md](../CONTRIBUTING.md#changes-and-releases).
