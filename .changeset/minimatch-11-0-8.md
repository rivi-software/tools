---
"@rivi-software/d1-migrations": patch
"@rivi-software/workers-bundle-check": patch
---

Depend on `minimatch` 11.0.8 or later instead of 11.0.5. A long pattern with many wildcards, such as `*a*a*a*a*b`, compiles faster ([GHSA-cf2h-pxjq-68xw](https://github.com/isaacs/minimatch/security/advisories/GHSA-cf2h-pxjq-68xw)). Before, its compile time grew with the square of the pattern's length. A pattern part with more than 256 extglobs, such as `?(a)` repeated, now throws `TypeError: pattern has too many extglobs` instead of overflowing the call stack. In a pattern with braces, such as `{a,b}/\\*`, an escaped backslash stays a literal backslash. Before, it could escape the next character instead. Other globs match the same files as before.
