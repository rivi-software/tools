---
"@rivi-software/workers-mail": patch
---

`sendMail`, `sendWithSes` and `sendWithBinding` now refuse an address that holds more than one address or a line break, with a `MailError` whose `code` is `validation_error`, before anything is sent. Several recipients go in an array, such as `to: ["jane@example.com", "bob@example.com"]`. A quoted name may still hold a comma or angle brackets, such as `"Doe, Jane" <jane@example.com>`.

Before, `to: "Jane <a@example.com>, Bob <b@example.com>"` went to `b@example.com` alone under the name `Jane <a@example.com>, Bob`, which showed Jane's address to Bob, and the send reported success. `"a@example.com, b@example.com"` went to SES as one address, which SES refused.
