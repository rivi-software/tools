import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MailError,
  sendRawMail,
  sendRawWithBinding,
  sendRawWithSes,
  type RawMail,
} from "../src/index.js";
import { signAwsRequest } from "../src/sigv4.js";
import { EmailMessage } from "./cloudflare-email.js";

const SES = {
  SES_REGION: "eu-west-1",
  SES_ACCESS_KEY_ID: "AKIATESTKEY",
  SES_SECRET_ACCESS_KEY: "test-secret",
};

const SES_CONFIG = { region: "eu-west-1", accessKeyId: "k", secretAccessKey: "s" };

/** A signed message as PGP/MIME writes it: the bytes the signature covers must arrive unchanged. */
const RAW = [
  "From: Jane Doe <jane@example.com>",
  "To: bob@example.org",
  "Cc: carol@example.org",
  "Subject: Signed",
  "Message-ID: <signed-1@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature";',
  ' boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=us-ascii",
  "",
  "Hello",
  "--b1",
  "Content-Type: application/pgp-signature",
  "",
  "-----BEGIN PGP SIGNATURE-----",
  "-----END PGP SIGNATURE-----",
  "--b1--",
  "",
].join("\r\n");

const AUTOCRYPT = "addr=jane@example.com; keydata=\r\n xjMEZ1AAAAAWCSsGAQQB2kcPAQEHQL0\r\n\tAAAA";

const MAIL: RawMail = {
  from: "jane@example.com",
  // Bcc's dave is in the envelope and nowhere in the message.
  recipients: ["bob@example.org", "carol@example.org", "dave@example.org"],
  raw: RAW,
  sesOnlyHeaders: { Autocrypt: AUTOCRYPT },
  tags: { kind: "pgp" },
};

/** A `send_email` binding that records each message and answers each with a Message-ID of its own. */
function binding(fail?: { at: number; error: Error & { code?: string } }) {
  const sent: EmailMessage[] = [];
  return {
    sent,
    EMAIL: {
      async send(message: EmailMessage) {
        if (fail && sent.length === fail.at) throw fail.error;
        sent.push(message);
        return { messageId: `<cf${sent.length}@example.com>` };
      },
    },
  };
}

type SesRequest = {
  url: string;
  method: string;
  headers: Headers;
  text: string;
  body: {
    FromEmailAddress: string;
    Destination: { ToAddresses: string[] };
    Content: { Raw: { Data: string } };
    ConfigurationSetName?: string;
    EmailTags?: { Name: string; Value: string }[];
  };
};

/** SES through a spy on the global `fetch`: answers each send with `answer`, records the request. */
function fakeSes(
  answer: () => Response | Promise<Response> = () =>
    Response.json({ MessageId: "0107-raw-000000" }),
) {
  const requests: SesRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      text,
      body: JSON.parse(text) as SesRequest["body"],
    });
    return answer();
  });
  return requests;
}

const refusal = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-amzn-ErrorType": `${type}:http://internal.amazon.com/coral/`,
    },
  });

const decoded = (data: string) => Buffer.from(data, "base64").toString("utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendRawMail", () => {
  it("sends through SES once it has a key: the message under the SES-only headers, signed for its region", async () => {
    const { sent, EMAIL } = binding();
    const requests = fakeSes();
    const result = await sendRawMail({ EMAIL, ...SES }, MAIL);
    expect(result).toEqual({
      transport: "ses",
      id: "0107-raw-000000",
      messageId: "<0107-raw-000000@eu-west-1.amazonses.com>",
    });
    expect(sent).toEqual([]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(request!.method).toBe("POST");
    expect(request!.headers.get("content-type")).toBe("application/json");
    expect(request!.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(request!.headers.get("x-amz-content-sha256")).toBe(sha256(request!.text));
    expect(request!.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(request!.body).toEqual({
      FromEmailAddress: "jane@example.com",
      Destination: { ToAddresses: ["bob@example.org", "carol@example.org", "dave@example.org"] },
      Content: { Raw: { Data: expect.any(String) } },
      EmailTags: [{ Name: "kind", Value: "pgp" }],
    });
    expect(decoded(request!.body.Content.Raw.Data)).toBe(`Autocrypt: ${AUTOCRYPT}\r\n${RAW}`);
  });

  it("hands a message SES refused to the binding: once per recipient, the same bytes, no SES-only headers", async () => {
    const { sent, EMAIL } = binding();
    fakeSes(() => refusal(403, "AccessDeniedException", "not authorized to perform ses:SendEmail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await sendRawMail({ EMAIL, ...SES }, MAIL);
    expect(result).toEqual({
      transport: "email-service",
      id: "<cf1@example.com>",
      messageId: "<cf1@example.com>",
    });
    expect(sent.map((m) => m instanceof EmailMessage && [m.from, m.to])).toEqual([
      ["jane@example.com", "bob@example.org"],
      ["jane@example.com", "carol@example.org"],
      ["jane@example.com", "dave@example.org"],
    ]);
    for (const message of sent) expect(message.raw).toBe(RAW);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({
      event: "mail.ses_refused",
      status: 403,
      code: "AccessDeniedException",
    });
  });

  it("sends through the binding while SES has no key", async () => {
    const { sent, EMAIL } = binding();
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await sendRawMail({ EMAIL, SES_REGION: "eu-west-1" }, MAIL);
    expect(result.transport).toBe("email-service");
    expect(sent.map((m) => m.to)).toEqual(MAIL.recipients);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends again through the binding when SES may have taken the message", async () => {
    const { sent, EMAIL } = binding();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const err = await sendRawMail({ EMAIL, ...SES }, MAIL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ transport: "ses", status: undefined, message: "fetch failed" });
    expect(sent).toEqual([]);
  });

  it("keeps SES's refusal without a binding, and refuses to send without either", async () => {
    fakeSes(() => refusal(400, "MessageRejected", "Email address is not verified."));
    await expect(sendRawMail(SES, MAIL)).rejects.toMatchObject({
      transport: "ses",
      status: 400,
      code: "MessageRejected",
      refusedMessage: true,
    });
    await expect(sendRawMail({}, MAIL)).rejects.toThrow(/^No mail transport/);
  });

  it("refuses an SES-only header that would break out of its line, before anything is sent", async () => {
    const { sent, EMAIL } = binding();
    const requests = fakeSes();
    const bad: Record<string, string>[] = [
      { Autocrypt: "addr=a@b\r\nBcc: eve@example.net" },
      { Autocrypt: "addr=a@b\n keydata=x" },
      { Autocrypt: "addr=a@b\r keydata=x" },
      { Autocrypt: "addr=a@b\r\n" },
      { Autocrypt: "addr=a@b\r\n " },
      { Autocrypt: "x\r\n \r\n y" },
      { "Auto crypt": "addr=a@b" },
      { "X-A:\r\nBcc": "eve@example.net" },
      { "": "x" },
    ];
    for (const sesOnlyHeaders of bad) {
      for (const env of [{ EMAIL, ...SES }, { EMAIL }]) {
        const err = await sendRawMail(env, { ...MAIL, sesOnlyHeaders }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MailError);
        expect(err).toMatchObject({
          transport: "ses",
          status: undefined,
          code: "validation_error",
        });
        // Never the value, which can carry what the message is about.
        expect((err as MailError).message).not.toContain("eve@");
      }
    }
    expect(requests).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("refuses a message without recipients on either transport", async () => {
    const { sent, EMAIL } = binding();
    const requests = fakeSes();
    const none = { ...MAIL, recipients: [] };
    await expect(sendRawMail({ EMAIL, ...SES }, none)).rejects.toMatchObject({
      transport: "ses",
      code: "validation_error",
    });
    await expect(sendRawMail({ EMAIL }, none)).rejects.toMatchObject({
      transport: "email-service",
      code: "validation_error",
    });
    expect(requests).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("sendRawWithSes", () => {
  it("names the configuration set, and sends a large message that is not all ASCII intact", async () => {
    const requests = fakeSes();
    // Over two of the slices the base64 encoding goes in, with characters of two, three and four bytes across them.
    const body = "Grüße, 東京 🙂\r\n".repeat(4000);
    const raw = `Subject: Large\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
    await sendRawWithSes(
      SES_CONFIG,
      { from: "a@example.com", recipients: ["b@example.org"], raw },
      { configurationSet: " newsletter " },
    );
    const [request] = requests;
    expect(request!.body.ConfigurationSetName).toBe("newsletter");
    expect(request!.body.EmailTags).toBeUndefined();
    expect(Buffer.byteLength(raw)).toBeGreaterThan(2 * 0x8000);
    expect(decoded(request!.body.Content.Raw.Data)).toBe(raw);
  });

  it("takes a folded SES-only header as it is", async () => {
    const requests = fakeSes();
    await sendRawWithSes(SES_CONFIG, {
      ...MAIL,
      sesOnlyHeaders: { Autocrypt: "addr=a@b; keydata=\r\n\tAAAA", "X-Two": "2" },
    });
    expect(decoded(requests[0]!.body.Content.Raw.Data)).toBe(
      `Autocrypt: addr=a@b; keydata=\r\n\tAAAA\r\nX-Two: 2\r\n${RAW}`,
    );
  });
});

describe("sendRawWithBinding", () => {
  it("says how many recipients took the message when the binding fails partway, never who", async () => {
    const { sent, EMAIL } = binding({
      at: 2,
      error: Object.assign(new Error("rate limit for dave@example.org"), {
        code: "E_RATE_LIMIT_EXCEEDED",
      }),
    });
    const err = await sendRawWithBinding(EMAIL, MAIL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({
      transport: "email-service",
      status: undefined,
      code: "E_RATE_LIMIT_EXCEEDED",
    });
    const { message, cause } = err as MailError;
    expect(message).toContain("2 of 3 recipients");
    expect(message).not.toMatch(/@/);
    expect((cause as Error).message).toBe("rate limit for dave@example.org");
    expect(sent).toHaveLength(2);
  });

  it("answers the binding's own failure when the first send fails", async () => {
    const { sent, EMAIL } = binding({
      at: 0,
      error: Object.assign(new Error("daily limit"), { code: "E_DAILY_LIMIT_EXCEEDED" }),
    });
    await expect(sendRawWithBinding(EMAIL, MAIL)).rejects.toMatchObject({
      name: "MailError",
      transport: "email-service",
      code: "E_DAILY_LIMIT_EXCEEDED",
      message: "daily limit",
    });
    expect(sent).toEqual([]);
  });
});

describe("signAwsRequest", () => {
  it("signs AWS's own example: S3's GET Object", async () => {
    // From "Signature Calculations for the Authorization Header" in the Amazon S3 API reference.
    const headers = await signAwsRequest(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: { Range: "bytes=0-9" },
        body: "",
      },
      {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
        service: "s3",
      },
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(headers).toEqual({
      Range: "bytes=0-9",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
      Authorization:
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    });
  });

  it("signs SES's call as the steps of Signature Version 4 compute it by hand", async () => {
    const body = '{"FromEmailAddress":"a@example.com"}';
    const headers = await signAwsRequest(
      {
        method: "POST",
        url: new URL("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails"),
        headers: { "content-type": "application/json" },
        body,
      },
      {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "secret",
        region: "eu-west-1",
        service: "ses",
      },
      new Date("2026-11-07T12:34:56.789Z"),
    );
    const canonical = [
      "POST",
      "/v2/email/outbound-emails",
      "",
      "content-type:application/json",
      "host:email.eu-west-1.amazonaws.com",
      `x-amz-content-sha256:${sha256(body)}`,
      "x-amz-date:20261107T123456Z",
      "",
      "content-type;host;x-amz-content-sha256;x-amz-date",
      sha256(body),
    ].join("\n");
    const toSign = [
      "AWS4-HMAC-SHA256",
      "20261107T123456Z",
      "20261107/eu-west-1/ses/aws4_request",
      sha256(canonical),
    ].join("\n");
    const key = ["20261107", "eu-west-1", "ses", "aws4_request"].reduce<Buffer | string>(
      (k, part) => createHmac("sha256", k).update(part).digest(),
      "AWS4secret",
    );
    const signature = createHmac("sha256", key).update(toSign).digest("hex");
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261107/eu-west-1/ses/aws4_request, " +
        `SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    );
  });
});
