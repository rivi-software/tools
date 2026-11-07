---
"@rivi-software/workers-mail": minor
---

Add `sendRawMail`, `sendRawWithSes` and `sendRawWithBinding`, which send a message written out in full, such as signed or encrypted PGP/MIME, byte for byte, with `sendMail`'s choice of transport and fallback. The binding sends it once per recipient, and `sesOnlyHeaders` carries headers only SES takes, such as `Autocrypt`.
