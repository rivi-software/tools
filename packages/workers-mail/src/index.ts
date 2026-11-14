import { createEmailClient, disableTelemetry } from "@opencoredev/email-sdk";
import type { EmailAdapter, EmailMessage } from "@opencoredev/email-sdk";
import { cloudflare } from "@opencoredev/email-sdk/cloudflare";
import type { CloudflareSendEmailBinding } from "@opencoredev/email-sdk/cloudflare";
import { ses } from "@opencoredev/email-sdk/ses";

import { parseMailAddress } from "./address.js";
import { signAwsRequest } from "./sigv4.js";

// The SDK reports every client and send to its maker's PostHog unless told not to. Off for the whole process,
// clients that other code creates included; every client here is created with `telemetry: false` as well.
disableTelemetry();

/** `jane@example.com`, `Jane <jane@example.com>`, or the address with its display name apart. */
export type MailAddress = string | { email: string; name?: string | null };

/** A file sent with the message: an attachment, or an inline image the HTML names as `cid:<contentId>`. */
export type MailAttachment = {
  filename: string;
  /** The MIME type. */
  type: string;
  /** The bytes, base64-encoded: local dev's binding cannot take an ArrayBuffer, and SES wants base64. */
  content: string;
} & (
  | { disposition: "attachment"; contentId?: undefined }
  | { disposition: "inline"; contentId: string }
);

/** A message for `sendMail`, `sendWithSes` or `sendWithBinding`; `text`, `html` or both. */
export interface Mail {
  from: MailAddress;
  to: MailAddress | readonly MailAddress[];
  cc?: readonly MailAddress[];
  bcc?: readonly MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  text?: string;
  html?: string;
  /** Headers SES and Email Service let a sender set: `In-Reply-To`, `References`, `List-Unsubscribe`, `Auto-Submitted`… */
  headers?: Record<string, string>;
  attachments?: readonly MailAttachment[];
  /** SES message tags, handed back on every event about the message; the binding has none and drops them. */
  tags?: Record<string, string>;
}

/** Which transport sent a message: Amazon SES, or Cloudflare Email Service's binding. */
export type MailTransport = "ses" | "email-service";

/** What `sendMail` answers once a message went out. */
export interface SentMail {
  transport: MailTransport;
  /** The provider's id for the message: SES's `MessageId`, or the binding's `messageId`. */
  id: string | null;
  /** The `Message-ID` header the message went out with, `<…>`, which a reply names in `In-Reply-To`. */
  messageId: string | null;
}

/** Cloudflare Email Service's `send_email` binding, typed loosely so `SendEmail` and a test's stand-in both fit. */
export interface EmailBinding {
  // oxlint-disable-next-line typescript/method-signature-style, anti-slop/no-unknown-returns -- a property signature checks parameters contravariantly, which stops a real SendEmail binding from fitting this shape; `unknown` is the widest answer one fits
  send(message: never): Promise<unknown>;
}

/** What a Worker sends with: SES's region and an IAM user's key, the `EMAIL` binding, or both. */
export interface MailEnv {
  EMAIL?: EmailBinding;
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  /** The configuration set `sendMail` and `sendRawMail` name to SES unless they are handed one. */
  SES_CONFIGURATION_SET?: string;
}

/** SES's region and an IAM user's access key, as `sesConfig` reads them from the Worker's env. */
export interface SesConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** A message already written out in full, for `sendRawMail`, `sendRawWithSes` or `sendRawWithBinding`. */
export interface RawMail {
  /** The envelope sender: a bare address on a domain the transport may send from. */
  from: string;
  /** The envelope recipients (To, Cc and Bcc together), bare addresses. The message itself names no Bcc. */
  recipients: readonly string[];
  /** The RFC 5322 message: its headers, a blank line, the body; CRLF line ends, 7-bit. */
  raw: string;
  /**
   * Headers SES carries above `raw` that Email Service's allowlist refuses (`Autocrypt`): the binding sends the
   * message without them. A value may be folded (CRLF, a space or tab, then more than white space); anything else
   * with CR or LF is refused.
   */
  sesOnlyHeaders?: Record<string, string>;
  /** SES message tags, as in `Mail`; the binding has none and drops them. */
  tags?: Record<string, string>;
}

/** A message that was not sent: what the transport answered, with SES's error type or the binding's code. */
export class MailError extends Error {
  readonly transport: MailTransport;
  /** The HTTP status SES answered with; absent when SES was not reached or the binding failed. */
  readonly status: number | undefined;
  /** SES's error type (`MessageRejected`, `TooManyRequestsException`) or the binding's (`E_RATE_LIMIT_EXCEEDED`). */
  readonly code: string | undefined;

  constructor(
    message: string,
    options: {
      transport: MailTransport;
      status?: number;
      code?: string;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "MailError";
    this.transport = options.transport;
    this.status = options.status;
    this.code = options.code;
  }

  /**
   * Whether SES refused this message itself (an address it will not take, a recipient the sandbox has not
   * verified), so sending it again fails the same way. Anything else is about the account, its quota, its setup
   * or the network, and passes.
   */
  get refusedMessage(): boolean {
    return (
      this.code === "MessageRejected" || this.code === "BadRequestException"
    );
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

/** Whether the address came with its parts apart, rather than as one written-out string. */
const isAddressParts = (
  address: MailAddress
): address is { email: string; name?: string | null } =>
  typeof address !== "string";

/** An address with its display name apart; `Jane <jane@example.com>` and `"Jane" <jane@example.com>` are read too. */
export const addressParts = (
  address: MailAddress
): { email: string; name: string | null } => {
  if (isAddressParts(address)) {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- the annotation is this package's published return type; inference would publish a union of the two branch shapes
    return { email: address.email, name: address.name?.trim() || null };
  }

  return parseMailAddress(address);
};

const bindingAddress = (
  address: MailAddress
): string | { email: string; name: string } => {
  const { email, name } = addressParts(address);

  return name ? { email, name } : email;
};

/**
 * An address as SES's `FromEmailAddress`, `ToAddresses` and `ReplyToAddresses` take it: the name quoted, or
 * MIME-encoded (RFC 2047) when it is not plain ASCII, since SES refuses raw UTF-8 there.
 */
export const formatSesAddress = (address: MailAddress): string => {
  const { email, name } = addressParts(address);

  if (!name) {
    return email;
  }

  if (/^[ -~]*$/u.test(name)) {
    return `"${name.replaceAll(/["\\]/gu, "\\$&")}" <${email}>`;
  }

  const bytes = new TextEncoder().encode(name);

  // oxlint-disable-next-line unicorn/prefer-code-point -- these are bytes, not code points: btoa reads one code unit per byte
  return `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?= <${email}>`;
};

/**
 * SES takes a header of at most 996 characters, its name and value together (a line of 998 with the `: `), so a
 * long thread's `References` is shortened to the 986 that leaves it.
 */
const SES_HEADER_MAX = 996;

/**
 * `References` cut to `max` characters the way RFC 5537 (3.4.4) trims it: the thread's first message, then as many
 * of the latest as fit, in order. Clients thread on the first and the last, which both stay. `max` defaults to what
 * SES takes, 986.
 */
export const fitReferences = (
  value: string,
  max = SES_HEADER_MAX - "References".length
): string => {
  if (value.length <= max) {
    return value;
  }

  const ids = value.split(/\s+/u).filter(Boolean);
  const [first] = ids;

  // Only whitespace: no message to keep.
  if (first === undefined) {
    return "";
  }

  const latest: string[] = [];
  let { length } = first;

  for (let i = ids.length - 1; i > 0; i -= 1) {
    const id = ids[i] ?? "";

    if (length + 1 + id.length > max) {
      break;
    }

    latest.unshift(id);
    length += 1 + id.length;
  }

  return [first, ...latest].join(" ");
};

const sesHeaders = (headers: Record<string, string>) =>
  Object.entries(headers).map(([name, value]) => ({
    name,
    value:
      name.toLowerCase() === "references"
        ? fitReferences(value, SES_HEADER_MAX - name.length)
        : value,
  }));

/**
 * The `Message-ID` SES gives a message it sent: its `MessageId` at the region's sending domain (`email` stands for
 * us-east-1). SES writes the Message-ID itself and takes none from a sender, so this is how a reply finds its way
 * back to the thread.
 */
export const sesMessageId = (region: string, id: string): string =>
  `<${id}@${region === "us-east-1" ? "email" : region}.amazonses.com>`;

/** What the Email SDK threw, as a `MailError`: SES's own when it answered, else the innermost error's words and code. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
const mailError = (err: unknown, transport: MailTransport): MailError => {
  let root: unknown = err;

  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e instanceof MailError) {
      return e;
    }

    root = e;
  }

  // SAFETY: a property read through `?.` is safe on any value; `isString` below decides whether it is a code.
  const code = (root as { code?: unknown } | null)?.code;

  return new MailError(root instanceof Error ? root.message : String(root), {
    transport,
    code: isString(code) ? code : undefined,
    cause: err,
  });
};

/** The `MailError` for an error answer from SES: the type from `x-amzn-ErrorType` or the body's `__type`. */
export const sesError = async (res: Response): Promise<MailError> => {
  // SAFETY: SES answers with a JSON object; a body that does not read falls back to `{}`.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SES's error bodies differ by error type, and only the two fields below are read
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  // "TooManyRequestsException:http://internal.amazon.com/coral/…" or "com.amazonaws…#MessageRejected".
  const type =
    res.headers.get("x-amzn-errortype") ??
    String(body.__type ?? `HTTP${res.status}`);

  const [beforeColon = type] = type.split(":");
  const code = beforeColon.split("#").at(-1) ?? beforeColon;

  return new MailError(String(body.message ?? body.Message ?? res.statusText), {
    transport: "ses",
    status: res.status,
    code,
  });
};

/**
 * `fetch` for the SES adapter: an error answer becomes a `MailError` with SES's error type, which the Email SDK
 * would otherwise fold into its message. The global `fetch` is looked up on each call, so a test's spy reaches it.
 */
const sesFetch = async (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const res = await fetch(input, init);

  if (res.ok) {
    return res;
  }

  throw await sesError(res);
};

const send = async (
  adapter: EmailAdapter,
  transport: MailTransport,
  message: EmailMessage
): Promise<{ id: string | null }> => {
  try {
    const client = createEmailClient({ adapters: [adapter], telemetry: false });
    const result = await client.send(message);

    return { id: result.id ?? null };
  } catch (error) {
    throw mailError(error, transport);
  }
};

/** The attachment as the Email SDK takes it; `contentId` only for an inline one. */
interface SdkAttachment {
  filename: string;
  contentType: string;
  content: string;
  contentEncoding: "base64";
  disposition: "attachment" | "inline";
  contentId?: string;
}

/** The fields of the Email SDK's message this package fills in; the rest it defaults. */
interface SdkMessage {
  from: string | { email: string; name: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string | { email: string; name: string };
  subject: string;
  text?: string;
  html?: string;
  attachments?: SdkAttachment[];
}

const sdkAttachment = (attachment: MailAttachment): SdkAttachment => {
  const sent: SdkAttachment = {
    filename: attachment.filename,
    contentType: attachment.type,
    content: attachment.content,
    contentEncoding: "base64",
    disposition: attachment.disposition,
  };

  if (attachment.contentId) {
    sent.contentId = attachment.contentId;
  }

  return sent;
};

/** The Email SDK's message from ours: recipients and senders formatted for the transport, the parts as they are. */
const envelope = (
  mail: Mail,
  recipient: (address: MailAddress) => string,
  sender: (address: MailAddress) => string | { email: string; name: string }
): EmailMessage => {
  const list = (
    addresses: MailAddress | readonly MailAddress[] | undefined
  ) => {
    if (addresses === undefined) {
      return;
    }

    // SAFETY: a MailAddress is a string or an object, never an array, so an array here is a list of them.
    const many: readonly MailAddress[] = Array.isArray(addresses)
      ? addresses
      : [addresses as MailAddress];

    return many.map(recipient);
  };

  const to = list(mail.to) ?? [];
  const cc = list(mail.cc);
  const bcc = list(mail.bcc);

  const message: SdkMessage = {
    from: sender(mail.from),
    // The Email SDK asks for a To: a message to Cc or Bcc alone goes To its sender, as many mail clients do.
    to: to.length || !(cc?.length || bcc?.length) ? to : [recipient(mail.from)],
    subject: mail.subject,
  };

  if (cc?.length) {
    message.cc = cc;
  }

  if (bcc?.length) {
    message.bcc = bcc;
  }

  if (mail.replyTo) {
    message.replyTo = sender(mail.replyTo);
  }

  if (mail.text !== undefined) {
    message.text = mail.text;
  }

  if (mail.html !== undefined) {
    message.html = mail.html;
  }

  if (mail.attachments?.length) {
    message.attachments = mail.attachments.map(sdkAttachment);
  }

  // SAFETY: the fields above are the ones the SDK reads; the rest of `EmailMessage` is optional.
  return message as EmailMessage;
};

/** The UTF-8 bytes of `text` in base64, a slice at a time: a message of megabytes is too many arguments at once. */
const base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x80_00) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- these are bytes, not code points: btoa reads one code unit per byte
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x80_00));
  }

  return btoa(binary);
};

// Without one, SES would read the recipients from the message's headers and the binding would send nothing.
const needsRecipients = (mail: RawMail, transport: MailTransport): void => {
  if (mail.recipients.length === 0) {
    throw new MailError("A raw message needs at least one recipient.", {
      transport,
      code: "validation_error",
    });
  }
};

const HEADER_NAME = /^[A-Za-z0-9-]+$/u;

// No CR or LF but in a fold: CRLF, then a space or tab, and a line that is more than white space. A line of
// white space alone is obsolete syntax (RFC 5322 §4.2) that some parsers read as the end of the header.
const HEADER_VALUE = /^[^\r\n]*(?:\r\n[ \t]+[^\r\n \t][^\r\n]*)*$/u;

/**
 * `sesOnlyHeaders` as the lines that go above the message. A line break that is not a fold would end the header
 * and write headers or a body of its own into the message, so it is refused before anything is sent, and without
 * a status, which would let the binding send the message instead.
 */
const sesHeaderLines = (
  headers: Record<string, string> | undefined
): string => {
  let lines = "";

  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) {
      throw new MailError(
        "A header name in sesOnlyHeaders is not letters, digits and hyphens.",
        {
          transport: "ses",
          code: "validation_error",
        }
      );
    }

    if (!HEADER_VALUE.test(value)) {
      throw new MailError(
        `The ${name} header in sesOnlyHeaders has a line break that is not a fold (CRLF, then a space or tab).`,
        { transport: "ses", code: "validation_error" }
      );
    }

    lines += `${name}: ${value}\r\n`;
  }

  return lines;
};

/** SES's region and key from the Worker's vars and secrets, or null while any of the three is missing. */
export const sesConfig = (env: MailEnv): SesConfig | null => {
  const region = env.SES_REGION?.trim();
  const accessKeyId = env.SES_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.SES_SECRET_ACCESS_KEY?.trim();

  return region && accessKeyId && secretAccessKey
    ? { region, accessKeyId, secretAccessKey }
    : null;
};

/** Whether the Worker can send at all: through SES or the binding. */
export const canSendMail = (env: MailEnv): boolean =>
  Boolean(sesConfig(env) || env.EMAIL);

/**
 * The transport `sendMail` and `sendRawMail` both choose, and the fallback from SES to the binding. SES gets the
 * configuration set the caller named, else the env's; the binding has none.
 */
const sendThrough = async (
  env: MailEnv,
  options: { configurationSet?: string },
  withSes: (
    config: SesConfig,
    sesOptions: { configurationSet?: string }
  ) => Promise<SentMail>,
  withBinding: (binding: EmailBinding) => Promise<SentMail>
): Promise<SentMail> => {
  const config = sesConfig(env);

  if (config) {
    try {
      return await withSes(config, {
        configurationSet: options.configurationSet ?? env.SES_CONFIGURATION_SET,
      });
    } catch (error) {
      if (
        !(error instanceof MailError && error.status !== undefined && env.EMAIL)
      ) {
        throw error;
      }

      // The code and status only: SES's message can name the recipient.
      console.warn(
        JSON.stringify({
          event: "mail.ses_refused",
          status: error.status,
          code: error.code,
        })
      );
    }
  }

  if (!env.EMAIL) {
    throw new MailError(
      "No mail transport: neither Amazon SES nor the EMAIL binding is set up.",
      {
        transport: "email-service",
      }
    );
  }

  return withBinding(env.EMAIL);
};

/** Sends through Amazon SES (API v2) alone; `configurationSet` names the set whose event destinations see it. */
export const sendWithSes = async (
  config: SesConfig,
  mail: Mail,
  options: { configurationSet?: string } = {}
): Promise<SentMail> => {
  const adapter = ses({
    ...config,
    configurationSetName: options.configurationSet?.trim() || undefined,
    fetch: sesFetch,
  });

  const result = await send(adapter, "ses", {
    ...envelope(mail, formatSesAddress, formatSesAddress),
    headers: mail.headers && sesHeaders(mail.headers),
    tags:
      mail.tags &&
      Object.entries(mail.tags).map(([name, value]) => ({ name, value })),
  });

  return {
    transport: "ses",
    id: result.id,
    messageId: result.id ? sesMessageId(config.region, result.id) : null,
  };
};

/** Sends through Email Service's `send_email` binding alone. Recipients go as bare addresses, as it requires. */
export const sendWithBinding = async (
  binding: EmailBinding,
  mail: Mail
): Promise<SentMail> => {
  // SAFETY: the adapter calls `send()` alone, which `EmailBinding` has; the SDK's type names a Workers runtime class this package cannot import.
  const adapter = cloudflare({
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the two shapes have no overlap TypeScript can see, so `unknown` is the only way through
    binding: binding as unknown as CloudflareSendEmailBinding,
  });

  const result = await send(adapter, "email-service", {
    ...envelope(mail, (a) => addressParts(a).email, bindingAddress),
    headers:
      mail.headers &&
      Object.entries(mail.headers).map(([name, value]) => ({ name, value })),
  });

  return { transport: "email-service", id: result.id, messageId: result.id };
};

/**
 * Sends a transactional message: through Amazon SES when the Worker holds its key, else through the `EMAIL`
 * binding. When SES answers with a refusal (its identity not verified yet, the IAM user not allowed to send as
 * the address, a throttle) nothing went out, so the binding sends it instead and a `mail.ses_refused` line says
 * why. Without an answer from SES (the network, a timeout) the message may have gone out, and the error stands:
 * sending it again could deliver it twice. List mail never comes here (`sendWithSes`): Email Service takes
 * transactional mail only. SES sends with the configuration set `configurationSet` names, else
 * `env.SES_CONFIGURATION_SET`, and an empty one sends without; the binding has no configuration sets.
 */
export const sendMail = (
  env: MailEnv,
  mail: Mail,
  options: { configurationSet?: string } = {}
): Promise<SentMail> =>
  sendThrough(
    env,
    options,
    (config, sesOptions) => sendWithSes(config, mail, sesOptions),
    (binding) => sendWithBinding(binding, mail)
  );

/**
 * Sends a raw message through Amazon SES (API v2) alone, `sesOnlyHeaders` above the message; `configurationSet`
 * names the set whose event destinations see it.
 */
export const sendRawWithSes = async (
  config: SesConfig,
  mail: RawMail,
  options: { configurationSet?: string } = {}
): Promise<SentMail> => {
  const headerLines = sesHeaderLines(mail.sesOnlyHeaders);
  needsRecipients(mail, "ses");

  const url = new URL(
    "/v2/email/outbound-emails",
    `https://email.${config.region}.amazonaws.com`
  );

  const body = JSON.stringify({
    FromEmailAddress: mail.from,
    // The envelope: SES delivers to these and reads no recipient from the message's headers.
    Destination: { ToAddresses: mail.recipients },
    Content: { Raw: { Data: base64(headerLines + mail.raw) } },
    ConfigurationSetName: options.configurationSet?.trim() || undefined,
    EmailTags:
      mail.tags &&
      Object.entries(mail.tags).map(([Name, Value]) => ({ Name, Value })),
  });

  let answer: { MessageId?: unknown };

  try {
    // The headers the Email SDK's SES adapter sends, and no timeout, as it has none.
    const headers = await signAwsRequest(
      {
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        body,
      },
      { ...config, service: "ses" }
    );

    const res = await sesFetch(url, { method: "POST", headers, body });
    // SES took the message once it answered with success, so a body that does not read is no failure.
    // SAFETY: a successful answer from SES is a JSON object; only `MessageId` is read, and only when it is a string.
    answer = (await res.json().catch(() => ({}))) as { MessageId?: unknown };
  } catch (error) {
    throw mailError(error, "ses");
  }

  const id = isString(answer.MessageId) ? answer.MessageId : null;

  return {
    transport: "ses",
    id,
    messageId: id ? sesMessageId(config.region, id) : null,
  };
};

/**
 * Sends a raw message through Email Service's binding alone. The binding takes raw MIME only as the `EmailMessage`
 * of `cloudflare:email`, which has one envelope recipient, so the message goes once per recipient, in order, the
 * same bytes each time and without `sesOnlyHeaders`. Answers the first send's `messageId`.
 */
export const sendRawWithBinding = async (
  binding: EmailBinding,
  mail: RawMail
): Promise<SentMail> => {
  needsRecipients(mail, "email-service");

  // Imported here rather than with the package, so the package still loads outside the Workers runtime.
  const { EmailMessage } = await import("cloudflare:email").catch(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- what a failed import rejects with is unknown until `mailError` reads it
    (error: unknown) => {
      throw mailError(error, "email-service");
    }
  );

  let first: string | null = null;

  for (const [sent, to] of mail.recipients.entries()) {
    let answer: unknown;

    try {
      // SAFETY: the binding's `send` takes the `EmailMessage` of `cloudflare:email`, which is what this builds.
      // oxlint-disable-next-line eslint/no-await-in-loop -- the binding takes one envelope recipient per send, and the count in the error below must say how many already went out
      answer = await binding.send(
        new EmailMessage(mail.from, to, mail.raw) as never
      );
    } catch (error) {
      const failure = mailError(error, "email-service");

      if (sent === 0) {
        throw failure;
      }

      // Counts only, never the addresses: the message reaches logs.
      throw new MailError(
        `The EMAIL binding sent the message to ${sent} of ${mail.recipients.length} recipients, then failed` +
          `${failure.code ? ` with ${failure.code}` : ""}; sending it again would deliver it twice to those ${sent}.`,
        { transport: "email-service", code: failure.code, cause: error }
      );
    }

    if (sent === 0) {
      // SAFETY: a property read through `?.` is safe on whatever the binding answered with.
      const id = (answer as { messageId?: unknown } | null | undefined)
        ?.messageId;

      first = isString(id) ? id : null;
    }
  }

  return { transport: "email-service", id: first, messageId: first };
};

/**
 * Sends a message the caller wrote out in full, such as signed or encrypted PGP/MIME, which has to go out byte for
 * byte as it was written; `sendMail` builds its message from fields and cannot carry one. The transport is chosen
 * as `sendMail` chooses it: SES when the Worker holds its key, else the `EMAIL` binding, and the binding when SES
 * answers with a refusal, never after an SES call that got no answer. The configuration set is chosen as for
 * `sendMail`.
 */
// oxlint-disable-next-line eslint/require-await -- without `async`, a refused sesOnlyHeaders would throw synchronously instead of rejecting the promise callers await
export const sendRawMail = async (
  env: MailEnv,
  mail: RawMail,
  options: { configurationSet?: string } = {}
): Promise<SentMail> => {
  // Refused whichever transport is set up, so a bad header fails where only the binding sends (local development)
  // as it would through SES.
  sesHeaderLines(mail.sesOnlyHeaders);

  return sendThrough(
    env,
    options,
    (config, sesOptions) => sendRawWithSes(config, mail, sesOptions),
    (binding) => sendRawWithBinding(binding, mail)
  );
};
