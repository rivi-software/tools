# @rivi-software/workers-mail

[![npm version](https://img.shields.io/npm/v/@rivi-software/workers-mail?label=npm&color=0b6b3a)](https://www.npmjs.com/package/@rivi-software/workers-mail) [![CI status](https://img.shields.io/github/actions/workflow/status/rivi-software/tools/ci.yml?branch=main&label=CI)](https://github.com/rivi-software/tools/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-0b6b3a)](LICENSE)

Mail from Cloudflare Workers through [Amazon SES](https://aws.amazon.com/ses/) once a Worker holds SES's key, and through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)'s `send_email` binding until then and whenever SES refuses a message. One call, `sendMail(env, mail)`, picks the transport, formats the addresses and headers for it, and answers with the `Message-ID` the message went out with, so a reply threads back.

The binding needs no keys and sends from the day a domain is onboarded; SES takes larger messages and list mail, but needs a verified identity, production access and an IAM key first. With both set up, mail keeps going while SES is not ready yet, and when SES refuses a message (an identity not verified yet, a policy that does not allow the address, a throttle) the binding sends it instead. SES goes through the [Email SDK](https://email-sdk.dev/docs/adapters/ses) (`@opencoredev/email-sdk`), which signs SES's API v2 requests with `fetch` and Web Crypto, so the Worker needs no AWS SDK. A message written out in full, such as signed or encrypted PGP/MIME, goes out unchanged through `sendRawMail` ([Raw mail](#raw-mail)).

## Install

```bash
npm install @rivi-software/workers-mail
```

The Worker needs Node.js compatibility, since the Email SDK imports Node's `fs`, `os`, `path` and `crypto` modules: it is on by default from compatibility date 2026-08-04, and an earlier date needs the `nodejs_compat` flag, without which the Worker fails to start (`No such module "node:fs/promises"`). The package is ESM only, and runs in Node 22 and later as well, for tests.

## Usage

```jsonc
// wrangler.jsonc
{
  // Node.js compatibility is on from this date; an earlier one needs "compatibility_flags": ["nodejs_compat"].
  "compatibility_date": "2026-10-15",
  // Cloudflare Email Service, for a domain onboarded to Email Sending.
  "send_email": [{ "name": "EMAIL" }],
  // Amazon SES: the region here, the key as two secrets (below).
  "vars": { "SES_REGION": "eu-west-1" },
}
```

```bash
npx wrangler secret put SES_ACCESS_KEY_ID
npx wrangler secret put SES_SECRET_ACCESS_KEY
```

```ts
import { MailError, sendMail } from "@rivi-software/workers-mail";

export default {
  async fetch(request, env) {
    try {
      const sent = await sendMail(env, {
        from: "Acme <no-reply@example.com>",
        to: "jane@example.org",
        subject: "Your sign-in link",
        text: "Sign in: https://example.com/sign-in/…",
        html: '<p><a href="https://example.com/sign-in/…">Sign in</a></p>',
      });
      // { transport: "ses" | "email-service", id, messageId: "<…>" }
      return Response.json(sent);
    } catch (err) {
      if (!(err instanceof MailError)) throw err;
      console.error(JSON.stringify({ event: "mail.failed", transport: err.transport, code: err.code }));
      return new Response("Mail is unavailable", { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
```

`sendMail` reads these names from the object it is handed, the Worker's `env` as a rule:

| Name | Kind | What |
| --- | --- | --- |
| `EMAIL` | `send_email` binding | Cloudflare Email Service. |
| `SES_REGION` | var | The AWS region SES sends from, such as `eu-west-1`. |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | secrets | The access key of an IAM user that may send ([below](#setting-up-ses)). |

SES is used once all three SES values are set; until then, or with any of them empty, the binding. A Worker that binds other names hands them over itself: `sendMail({ EMAIL: env.MAILER, SES_REGION: env.AWS_REGION, … }, mail)`.

## How it works

`sendMail(env, mail)` sends through SES when `env` has its region and key, else through `env.EMAIL`. When SES answers with an error status, the binding sends the message instead. A refusal (4xx) means SES sent nothing. A server error (5xx) almost always means the same, but does not prove it, so in that rare case the message can arrive twice. `console.warn` then writes one line for the logs with SES's status and error type, never its message, which can name the recipient:

```json
{"event":"mail.ses_refused","status":403,"code":"AccessDeniedException"}
```

Without an answer from SES (the network, a timeout) the message may have gone out, so the error stands: sending it again through the binding could deliver it twice. Without the binding, SES's error stands too. What a transport refuses or fails at comes as a `MailError`, and so does a Worker with neither transport set up.

What differs between the two transports, and what the package does about it:

- **Message-ID.** Both write their own and take none from the sender. SES's is its `MessageId` at the region's sending domain, `<…@eu-west-1.amazonses.com>` (`<…@email.amazonses.com>` in us-east-1); the binding answers with its own. `SentMail.messageId` is that header either way, so a reply that names it in `In-Reply-To` threads back.
- **Display names.** SES takes a name quoted, or MIME-encoded (RFC 2047) when it is not ASCII (`formatSesAddress`). Through the binding, recipients go as bare addresses, since the Email SDK's Cloudflare adapter refuses named ones, so their names are dropped there; the sender's and the Reply-To's stay.
- **Headers.** SES takes a header of at most 996 characters, its name and value together, so a long thread's `References` is cut to the first message and the latest that fit, the way RFC 5537 (3.4.4) trims it (`fitReferences`). Email Service takes a value of up to 2,048 bytes, refuses a longer one with `E_HEADER_VALUE_TOO_LONG`, and takes only the headers on [its allowlist](https://developers.cloudflare.com/email-service/reference/headers/) and `X-` headers. The package hands the binding the headers as they are, so a long thread passes `References: fitReferences(references)`, which fits both. Neither takes `Message-ID`, `Date` or the address headers as custom headers.
- **A To.** The Email SDK asks for one: a message to Cc or Bcc alone goes To its sender, as many mail clients do.
- **Size.** Email Service takes up to 5 MiB, attachments included (25 MiB to the account's verified destination addresses), and 32 attachments; SES 40 MB, the base64 encoding counted. Both take 50 recipients.
- **Tags.** SES message tags (`mail.tags`) come back on every SES event about the message; the binding has none and drops them.
- **List mail.** Email Service takes transactional mail only, so newsletters and other list mail go through `sendWithSes`, which never falls back.
- **Idempotency.** Neither has any; a caller that retries can deliver twice.

## Raw mail

`sendMail` hands the transport fields, and the transport writes the message. A message that has to go out byte for byte as it was written, such as PGP/MIME (RFC 3156: `multipart/signed`, `multipart/encrypted`), whose signature covers the bytes of a part, goes through `sendRawMail(env, mail)` instead. It chooses the transport as `sendMail` does, hands a message SES refused to the binding on the same terms, and writes the same `mail.ses_refused` line.

```ts
import { sendRawMail } from "@rivi-software/workers-mail";

const sent = await sendRawMail(env, {
  from: "jane@example.com",
  // To, Cc and Bcc together: the message names no Bcc.
  recipients: ["bob@example.org", "carol@example.org", "dave@example.org"],
  // Its headers, a blank line, the body; CRLF line ends, 7-bit.
  raw,
  sesOnlyHeaders: { Autocrypt: "addr=jane@example.com; keydata=…" },
});
```

- **The envelope.** `from` and `recipients` are bare addresses, and they are where the message goes: neither transport reads a recipient from the message's headers. A Bcc recipient is in `recipients` and nowhere in `raw`, or every recipient would see it. A message without recipients is refused.
- **SES** takes the message as `Content.Raw` of API v2's `SendEmail`. The Email SDK's adapter sends structured content only, so the package signs this call itself, with Signature Version 4 in Web Crypto. SES writes its own `Message-ID` over the message's, and `SentMail.messageId` names it, as for `sendMail`.
- **The binding** takes a message written out in full only as the `EmailMessage` of `cloudflare:email`, which has one envelope recipient. So the message goes once per recipient, in order, the same bytes each time, and each send counts as a message against Email Service's limits; `SentMail` names the first send's `messageId`. When a send fails after others went, the `MailError` has the binding's `code` and says how many of how many recipients took the message, counts and never addresses, since it reaches logs: sending it again would deliver it twice to those. The package imports `cloudflare:email` only when the binding sends, so it still loads outside the Workers runtime.
- **SES-only headers.** Email Service takes only the headers on [its allowlist](https://developers.cloudflare.com/email-service/reference/headers/), so a header it refuses, such as `Autocrypt`, goes in `sesOnlyHeaders`: SES gets it on a line above the message, and the binding gets the message without it. PGP/MIME signs a part and never the message's own headers, so the signature still holds. A value may be folded (CRLF, then a space or tab, then more than white space: a line of white space alone reads as the end of the header to some parsers). A name of anything but letters, digits and hyphens, or a value with any other CR or LF, would write a header or a body of its own into the message, so it is refused before anything is sent, with a `MailError` that has no status, whichever transport is set up.
- **Tags.** SES gets `tags` as for `sendMail`; the binding drops them.

`sendRawWithSes(config, mail, { configurationSet })` and `sendRawWithBinding(binding, mail)` send through one transport alone, and never fall back.

## Exports

From `@rivi-software/workers-mail`:

| Export | What |
| --- | --- |
| `sendMail(env, mail)` | Transactional mail: SES when `env` holds its region and key, else `env.EMAIL`, and `env.EMAIL` when SES refuses the message ([How it works](#how-it-works)). Answers `SentMail`: the `transport`, the provider's `id` and the `messageId` header. |
| `sendWithSes(config, mail, { configurationSet })` | SES alone, never the binding: list mail, which Email Service does not take, with the configuration set whose event destinations report its bounces and complaints. |
| `sendWithBinding(binding, mail)` | The binding alone. |
| `sendRawMail(env, mail)` | A message written out in full (`RawMail`), with `sendMail`'s choice of transport and fallback ([Raw mail](#raw-mail)). |
| `sendRawWithSes(config, mail, { configurationSet })` | A raw message through SES alone. |
| `sendRawWithBinding(binding, mail)` | A raw message through the binding alone: one send per recipient. |
| `canSendMail(env)`, `sesConfig(env)` | Whether a Worker can send at all; SES's region and key, or null while one of them is missing. |
| `MailError` | A message that was not sent: `transport`, SES's HTTP `status` (absent when SES was not reached or the binding failed), `code` (SES's error type such as `MessageRejected`, or the binding's such as `E_RATE_LIMIT_EXCEEDED`) and `refusedMessage`, true when SES refused the message itself, so that sending it again fails the same way. |
| `sesError(response)` | The `MailError` for an error answer from SES's API, for calls the Email SDK does not make, such as reading the account's quota with `GetAccount`. |
| `addressParts(address)` | `{ email, name }` for any `MailAddress`. |
| `formatSesAddress(address)` | The address as SES takes it: the name quoted, or MIME-encoded when it is not ASCII. |
| `fitReferences(value, max = 986)` | A `References` value cut to `max` characters: the first message and the latest. |
| `sesMessageId(region, id)` | The `Message-ID` header SES gives the message it answered `id` for. |
| Types | `Mail`, `RawMail`, `MailAddress`, `MailAttachment`, `MailEnv`, `MailTransport`, `SentMail`, `SesConfig`, `EmailBinding`. |

A `Mail` has `from`, `to` (one address or a list), `cc`, `bcc` and `replyTo`, each address as `jane@example.com`, `Jane <jane@example.com>` or `{ email, name }`; a `subject`; `text` and/or `html`; `headers`; `attachments` as base64 (`disposition` `attachment`, or `inline` with the `contentId` the HTML names as `cid:`); and SES message `tags`.

A `RawMail` has the envelope's `from` and `recipients` as bare addresses, the message as `raw`, `sesOnlyHeaders` and SES message `tags`.

From `@rivi-software/workers-mail/address`:

| Export | What |
| --- | --- |
| `parseMailAddress(raw)` | `{ email, name }` for `jane@example.com`, `Jane <jane@example.com>` or `"Jane Doe" <jane@example.com>`, and anything else as an address alone. It reads each character a fixed number of times, so a long or crafted name costs its length and no more. The entry point is its own so a browser bundle, an address field in a form, leaves the Email SDK out. |

## Telemetry

The Email SDK reports every client it creates and every send to its maker's PostHog unless told not to. When the package loads, it calls the SDK's `disableTelemetry()`, which turns that off for the whole process, Email SDK clients that your own code creates included, and every client the package creates passes `telemetry: false` as well. [`tests/mail.test.ts`](https://github.com/rivi-software/tools/blob/main/packages/workers-mail/tests/mail.test.ts) checks that a send makes one request, to SES, with `NODE_ENV` and the SDK's opt-out variables out of the way.

## Setting up SES

Until these steps are done the binding sends everything, so they can wait until SES is needed. In the AWS console, in the region the Worker will send from, and in the DNS of each domain it sends from:

1. **Identity.** SES → Identities → Create identity → Domain: `<domain>`, with Easy DKIM (RSA 2048-bit), and its three DKIM CNAME records in the domain's DNS (DNS only, if Cloudflare serves it). They use selectors of their own, so they sit beside Email Service's DKIM record and both keep signing. A custom MAIL FROM domain, such as `ses-bounce.<domain>` (Email Service uses `cf-bounce.<domain>`), with the MX and TXT records SES lists, aligns SPF as well; DKIM alone already passes DMARC.
2. **Production access.** A new SES account is in the sandbox: it sends only to verified addresses, 200 messages a day. Ask for production access on SES's account dashboard; until SES grants it, it refuses other recipients with `MessageRejected` and the binding sends their mail.
3. **Key.** An IAM user for each Worker with only `ses:SendEmail` on the identity, for the addresses the Worker sends from, and an access key for it, which goes into the Worker's two secrets; `SES_REGION` is a var in its config ([Usage](#usage)).

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "ses:SendEmail",
         "Resource": "arn:aws:ses:<region>:<account id>:identity/<domain>",
         "Condition": { "StringLike": { "ses:FromAddress": ["<address>"] } }
       }
     ]
   }
   ```

   `ses:FromAddress` takes wildcards (`*@<domain>`). A Worker that sends with a configuration set (`sendWithSes`) also needs `ses:SendEmail` on that set: add `arn:aws:ses:<region>:<account id>:configuration-set/<name>` to `Resource`.
4. **Check.** Send what the Worker sends (a sign-in link, a password reset) and look in its logs (Workers Logs, `wrangler tail`): no `mail.ses_refused` line means SES took the message. A line names SES's error type: `UnrecognizedClientException` or `SignatureDoesNotMatch` is the key, `AccessDeniedException` the IAM policy, `MessageRejected` with "not verified" the identity or the sandbox. Until it is fixed the binding keeps sending. Deleting the two secrets goes back to the binding.

SES's account-level suppression list (SES → Configuration → Suppression list) keeps it from sending again to an address that bounced or complained; check that it covers both. `sendMail` uses no configuration set, so its mail has no event destination.

## Testing a Worker that sends

The package's own tests run in Node with Vitest: SES is answered by a spy on the global `fetch`, which the package looks up on each call, and the binding by an object that records what it was handed. A Worker's tests can do the same: leave the three SES values empty and pass an `EMAIL` that records the mail, or set them and spy on `fetch` to answer as SES does ([`tests/mail.test.ts`](https://github.com/rivi-software/tools/blob/main/packages/workers-mail/tests/mail.test.ts) has both). Raw mail through the binding needs `cloudflare:email`, which Node lacks: the package's `vitest.config.ts` points it at a stand-in `EmailMessage` that keeps the message readable ([`tests/raw.test.ts`](https://github.com/rivi-software/tools/blob/main/packages/workers-mail/tests/raw.test.ts)).

## Limits

- Workers need Node.js compatibility for the Email SDK's Node imports: the default from compatibility date 2026-08-04, the `nodejs_compat` flag before it.
- No retries, and no idempotency in either transport: a caller that retries can deliver twice.
- `References` is fitted for SES alone; Email Service refuses a header value over 2,048 bytes ([Headers](#how-it-works)).
- Attachments are base64 strings: Email Service's local simulator in `wrangler dev` cannot take an `ArrayBuffer`, and SES wants base64.
- Through the binding, recipients' display names are dropped.
- Raw mail through the binding goes once per recipient, and a failure partway leaves it sent to some of them ([Raw mail](#raw-mail)).

## Development

The tests in `tests/` cover both transports and the fallback between them against a stand-in SES and binding, the addresses and headers each transport takes, the telemetry opt-out (`mail.test.ts`), raw mail and the Signature Version 4 signer against AWS's own example (`raw.test.ts`) and the address parser (`address.test.ts`). None of them sends mail. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 RIVI Software.

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>Part of <a href="https://github.com/rivi-software/tools#readme">RIVI tools</a>, the packages <a href="https://rivi.software">RIVI Software</a> builds its own apps with.</sub>
</p>
