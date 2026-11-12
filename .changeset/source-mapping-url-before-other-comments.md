---
"@rivi-software/workers-bundle-check": patch
---

The check now finds a `sourceMappingURL` comment that other comments follow, such as `//# debugId=…` or `//# sourceURL=…`. Only whitespace and comments may come after it, so a comment that code follows still does not count. Before, the comment had to end the file. A served script that carried its map inline and ended with `//# debugId=…` passed the check unreported, and in `serverDir` a map named anything but `<file>.map` was not found, so the module rules reported `missing-source-map`.
