---
"@rivi-software/deploy-watch": patch
---

`client` in `build.json` now covers each browser file's name and exact content, so it changes whenever a file a tab could load is renamed or changed. Before, it took file names and the build's id out, as the module fingerprints do: in an app that writes its commit into its browser code, a server-only commit renamed chunks but kept `client`, so a tab on the old build skipped the whole-page load at its next move and could hit a chunk the new deploy no longer served. Module fingerprints still ignore file names and the id, so the notice stays as it was. A `buildId` shorter than seven characters (a CI build number) is no longer taken out of module fingerprints, where it hid changes to any run of characters containing it.
