# @rivi-software/workers-mail

## 0.2.0

### Minor Changes

- 1cbed8f: Add `sendRawMail`, `sendRawWithSes` and `sendRawWithBinding`, which send a message written out in full, such as signed or encrypted PGP/MIME, byte for byte, with `sendMail`'s choice of transport and fallback. The binding sends it once per recipient, and `sesOnlyHeaders` carries headers only SES takes, such as `Autocrypt`.

## 0.1.1

### Patch Changes

- e94ffc5: Add doc comments to the `Mail`, `MailAttachment`, `MailTransport`, `SentMail` and `SesConfig` types, npm keywords, and a Development section in the README.
