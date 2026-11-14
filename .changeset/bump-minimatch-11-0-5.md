---
"@rivi-software/d1-migrations": patch
"@rivi-software/workers-bundle-check": patch
---

Depend on `minimatch` 11.0.5 or later instead of 11.0.4. Globs match the same files as before, and a pattern with a numeric brace range of 100 or more values, such as `{0..999}`, compiles faster.
