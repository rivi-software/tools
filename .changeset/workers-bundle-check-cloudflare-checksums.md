---
"@rivi-software/workers-bundle-check": minor
---

A secret pattern can now say whether a value it matched is one: `SecretPattern` takes an optional `verify(value)`, and the check reports a value only when `verify` returns `true`. The built-in Cloudflare patterns use it for the user and account API tokens (`cfut_`, `cfat_`) and the Access service token secrets (`cfast_`), whose last 8 characters are the CRC32 of the 40 before them. Before, any string of that shape failed the check, whether or not its checksum held, such as a made-up example token in a docs page. A Global API key (`cfk_`) is still found by its shape alone. The package now needs Node 22.2 or later, for `zlib.crc32`.
