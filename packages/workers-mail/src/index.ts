import {
  createEmailClient,
  disableTelemetry,
  type EmailAdapter,
  type EmailMessage,
} from "@opencoredev/email-sdk";
import { cloudflare, type CloudflareSendEmailBinding } from "@opencoredev/email-sdk/cloudflare";
import { ses } from "@opencoredev/email-sdk/ses";
import { parseMailAddress } from "./address.js";

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
export type Mail = {
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
};

/** Which transport sent a message: Amazon SES, or Cloudflare Email Service's binding. */
export type MailTransport = "ses" | "email-service";

/** What `sendMail` answers once a message went out. */
export type SentMail = {
  transport: MailTransport;
  /** The provider's id for the message: SES's `MessageId`, or the binding's `messageId`. */
  id: string | null;
  /** The `Message-ID` header the message went out with, `<…>`, which a reply names in `In-Reply-To`. */
  messageId: string | null;
};

/** Cloudflare Email Service's `send_email` binding, typed loosely so `SendEmail` and a test's stand-in both fit. */
export type EmailBinding = { send(message: never): Promise<unknown> };

/** What a Worker sends with: SES's region and an IAM user's key, the `EMAIL` binding, or both. */
export type MailEnv = {
  EMAIL?: EmailBinding;
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
};

/** SES's region and an IAM user's access key, as `sesConfig` reads them from the Worker's env. */
export type SesConfig = { region: string; accessKeyId: string; secretAccessKey: string };

/** A message that was not sent: what the transport answered, with SES's error type or the binding's code. */
export class MailError extends Error {
  readonly transport: MailTransport;
  /** The HTTP status SES answered with; absent when SES was not reached or the binding failed. */
  readonly status: number | undefined;
  /** SES's error type (`MessageRejected`, `TooManyRequestsException`) or the binding's (`E_RATE_LIMIT_EXCEEDED`). */
  readonly code: string | undefined;

  constructor(
    message: string,
    options: { transport: MailTransport; status?: number; code?: string; cause?: unknown },
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
    return this.code === "MessageRejected" || this.code === "BadRequestException";
  }
}

/** SES's region and key from the Worker's vars and secrets, or null while any of the three is missing. */
export function sesConfig(env: MailEnv): SesConfig | null {
  const region = env.SES_REGION?.trim();
  const accessKeyId = env.SES_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.SES_SECRET_ACCESS_KEY?.trim();
  return region && accessKeyId && secretAccessKey ? { region, accessKeyId, secretAccessKey } : null;
}

/** Whether the Worker can send at all: through SES or the binding. */
export function canSendMail(env: MailEnv): boolean {
  return Boolean(sesConfig(env) || env.EMAIL);
}

/**
 * Sends a transactional message: through Amazon SES when the Worker holds its key, else through the `EMAIL`
 * binding. When SES answers with a refusal (its identity not verified yet, the IAM user not allowed to send as
 * the address, a throttle) nothing went out, so the binding sends it instead and a `mail.ses_refused` line says
 * why. Without an answer from SES (the network, a timeout) the message may have gone out, and the error stands:
 * sending it again could deliver it twice. List mail never comes here (`sendWithSes`): Email Service takes
 * transactional mail only.
 */
export async function sendMail(env: MailEnv, mail: Mail): Promise<SentMail> {
  const config = sesConfig(env);
  if (config) {
    try {
      return await sendWithSes(config, mail);
    } catch (err) {
      if (!(err instanceof MailError && err.status !== undefined && env.EMAIL)) throw err;
      // The code and status only: SES's message can name the recipient.
      console.warn(
        JSON.stringify({ event: "mail.ses_refused", status: err.status, code: err.code }),
      );
    }
  }
  if (!env.EMAIL)
    throw new MailError("No mail transport: neither Amazon SES nor the EMAIL binding is set up.", {
      transport: "email-service",
    });
  return sendWithBinding(env.EMAIL, mail);
}

/** Sends through Amazon SES (API v2) alone; `configurationSet` names the set whose event destinations see it. */
export async function sendWithSes(
  config: SesConfig,
  mail: Mail,
  options: { configurationSet?: string } = {},
): Promise<SentMail> {
  const adapter = ses({
    ...config,
    configurationSetName: options.configurationSet?.trim() || undefined,
    fetch: sesFetch,
  });
  const result = await send(adapter, "ses", {
    ...envelope(mail, formatSesAddress, formatSesAddress),
    headers: mail.headers && sesHeaders(mail.headers),
    tags: mail.tags && Object.entries(mail.tags).map(([name, value]) => ({ name, value })),
  });
  return {
    transport: "ses",
    id: result.id,
    messageId: result.id ? sesMessageId(config.region, result.id) : null,
  };
}

/** Sends through Email Service's `send_email` binding alone. Recipients go as bare addresses, as it requires. */
export async function sendWithBinding(binding: EmailBinding, mail: Mail): Promise<SentMail> {
  const adapter = cloudflare({ binding: binding as unknown as CloudflareSendEmailBinding });
  const result = await send(adapter, "email-service", {
    ...envelope(mail, (a) => addressParts(a).email, bindingAddress),
    headers: mail.headers && Object.entries(mail.headers).map(([name, value]) => ({ name, value })),
  });
  return { transport: "email-service", id: result.id, messageId: result.id };
}

async function send(
  adapter: EmailAdapter,
  transport: MailTransport,
  message: EmailMessage,
): Promise<{ id: string | null }> {
  try {
    const client = createEmailClient({ adapters: [adapter], telemetry: false });
    const result = await client.send(message);
    return { id: result.id ?? null };
  } catch (err) {
    throw mailError(err, transport);
  }
}

/** The Email SDK's message from ours: recipients and senders formatted for the transport, the parts as they are. */
function envelope(
  mail: Mail,
  recipient: (address: MailAddress) => string,
  sender: (address: MailAddress) => string | { email: string; name: string },
): EmailMessage {
  const list = (addresses: MailAddress | readonly MailAddress[] | undefined) =>
    addresses === undefined
      ? undefined
      : (Array.isArray(addresses) ? addresses : [addresses as MailAddress]).map(recipient);
  const to = list(mail.to) ?? [];
  const cc = list(mail.cc);
  const bcc = list(mail.bcc);
  return {
    from: sender(mail.from),
    // The Email SDK asks for a To: a message to Cc or Bcc alone goes To its sender, as many mail clients do.
    to: to.length || !(cc?.length || bcc?.length) ? to : [recipient(mail.from)],
    ...(cc?.length ? { cc } : {}),
    ...(bcc?.length ? { bcc } : {}),
    ...(mail.replyTo ? { replyTo: sender(mail.replyTo) } : {}),
    subject: mail.subject,
    ...(mail.text !== undefined ? { text: mail.text } : {}),
    ...(mail.html !== undefined ? { html: mail.html } : {}),
    ...(mail.attachments?.length
      ? {
          attachments: mail.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.type,
            content: a.content,
            contentEncoding: "base64" as const,
            disposition: a.disposition,
            ...(a.contentId ? { contentId: a.contentId } : {}),
          })),
        }
      : {}),
  } as EmailMessage;
}

/** An address with its display name apart; `Jane <jane@example.com>` and `"Jane" <jane@example.com>` are read too. */
export function addressParts(address: MailAddress): { email: string; name: string | null } {
  if (typeof address !== "string")
    return { email: address.email, name: address.name?.trim() || null };
  return parseMailAddress(address);
}

function bindingAddress(address: MailAddress): string | { email: string; name: string } {
  const { email, name } = addressParts(address);
  return name ? { email, name } : email;
}

/**
 * An address as SES's `FromEmailAddress`, `ToAddresses` and `ReplyToAddresses` take it: the name quoted, or
 * MIME-encoded (RFC 2047) when it is not plain ASCII, since SES refuses raw UTF-8 there.
 */
export function formatSesAddress(address: MailAddress): string {
  const { email, name } = addressParts(address);
  if (!name) return email;
  if (/^[ -~]*$/.test(name)) return `"${name.replace(/["\\]/g, "\\$&")}" <${email}>`;
  const bytes = new TextEncoder().encode(name);
  return `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?= <${email}>`;
}

/**
 * SES takes a header of at most 996 characters, its name and value together (a line of 998 with the `: `), so a
 * long thread's `References` is shortened to the 986 that leaves it.
 */
const SES_HEADER_MAX = 996;

function sesHeaders(headers: Record<string, string>) {
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value:
      name.toLowerCase() === "references"
        ? fitReferences(value, SES_HEADER_MAX - name.length)
        : value,
  }));
}

/**
 * `References` cut to `max` characters the way RFC 5537 (3.4.4) trims it: the thread's first message, then as many
 * of the latest as fit, in order. Clients thread on the first and the last, which both stay. `max` defaults to what
 * SES takes, 986.
 */
export function fitReferences(value: string, max = SES_HEADER_MAX - "References".length): string {
  if (value.length <= max) return value;
  const ids = value.split(/\s+/).filter(Boolean);
  const first = ids[0]!;
  const latest: string[] = [];
  let length = first.length;
  for (let i = ids.length - 1; i > 0; i--) {
    if (length + 1 + ids[i]!.length > max) break;
    latest.unshift(ids[i]!);
    length += 1 + ids[i]!.length;
  }
  return [first, ...latest].join(" ");
}

/**
 * The `Message-ID` SES gives a message it sent: its `MessageId` at the region's sending domain (`email` stands for
 * us-east-1). SES writes the Message-ID itself and takes none from a sender, so this is how a reply finds its way
 * back to the thread.
 */
export function sesMessageId(region: string, id: string): string {
  return `<${id}@${region === "us-east-1" ? "email" : region}.amazonses.com>`;
}

/**
 * `fetch` for the SES adapter: an error answer becomes a `MailError` with SES's error type, which the Email SDK
 * would otherwise fold into its message. The global `fetch` is looked up on each call, so a test's spy reaches it.
 */
async function sesFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.ok) return res;
  throw await sesError(res);
}

/** The `MailError` for an error answer from SES: the type from `x-amzn-ErrorType` or the body's `__type`. */
export async function sesError(res: Response): Promise<MailError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // "TooManyRequestsException:http://internal.amazon.com/coral/…" or "com.amazonaws…#MessageRejected".
  const type = res.headers.get("x-amzn-errortype") ?? String(body.__type ?? `HTTP${res.status}`);
  const code = type.split(":")[0]!.split("#").pop()!;
  return new MailError(String(body.message ?? body.Message ?? res.statusText), {
    transport: "ses",
    status: res.status,
    code,
  });
}

/** What the Email SDK threw, as a `MailError`: SES's own when it answered, else the innermost error's words and code. */
function mailError(err: unknown, transport: MailTransport): MailError {
  let root: unknown = err;
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e instanceof MailError) return e;
    root = e;
  }
  const code = (root as { code?: unknown } | null)?.code;
  return new MailError(root instanceof Error ? root.message : String(root), {
    transport,
    code: typeof code === "string" ? code : undefined,
    cause: err,
  });
}
