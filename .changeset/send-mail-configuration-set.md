---
"@rivi-software/workers-mail": minor
---

`sendMail` and `sendRawMail` now send through SES with a configuration set, so its event destinations report the bounces and complaints of transactional mail: `sendMail(env, mail, { configurationSet: "transactional" })`, or `SES_CONFIGURATION_SET` in the Worker's env for every message. A message SES refuses still goes through the `EMAIL` binding, without a set, since Email Service has none. Before, only `sendWithSes` and `sendRawWithSes` took a set, and they never fall back to the binding. The IAM user needs `ses:SendEmail` on the set as well ([Setting up SES](https://github.com/rivi-software/tools/tree/main/packages/workers-mail#setting-up-ses)).
