import { getTelemetryStatus } from "@opencoredev/email-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MailError,
  canSendMail,
  fitReferences,
  formatSesAddress,
  sendMail,
  sendWithSes,
  sesMessageId,
  type Mail,
} from "../src/index.js";

const SES = {
  SES_REGION: "eu-west-1",
  SES_ACCESS_KEY_ID: "AKIATESTKEY",
  SES_SECRET_ACCESS_KEY: "test-secret",
};

const SES_CONFIG = { region: "eu-west-1", accessKeyId: "k", secretAccessKey: "s" };

const MAIL: Mail = {
  from: { email: "support@example.com", name: "Acme Support" },
  to: [{ email: "jane@example.org", name: "Jane Doe" }, "bob@example.org"],
  replyTo: "support+t1@example.com",
  subject: "Re: Your question",
  text: "Hello",
  html: "<p>Hello</p>",
  headers: {
    "In-Reply-To": "<q1@example.org>",
    References: "<q0@example.org> <q1@example.org>",
  },
  attachments: [
    { filename: "log.txt", type: "text/plain", content: btoa("log"), disposition: "attachment" },
    {
      filename: "logo.png",
      type: "image/png",
      content: btoa("png"),
      disposition: "inline",
      contentId: "logo1",
    },
  ],
};

/** A `send_email` binding that records what it was handed. */
function binding(fail?: Error & { code?: string }) {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    EMAIL: {
      async send(message: Record<string, unknown>) {
        if (fail) throw fail;
        sent.push(message);
        return { messageId: "<cf1@example.com>" };
      },
    },
  };
}

type SesRequest = {
  url: string;
  authorization: string;
  body: Record<string, unknown> & {
    ConfigurationSetName?: string;
    Content: { Simple: { Headers?: { Name: string; Value: string }[] } };
  };
};

/** SES through a spy on the global `fetch`: answers each send with `answer`, records the request. */
function fakeSes(
  answer: () => Response | Promise<Response> = () =>
    Response.json({ MessageId: "0107-abc-000000" }),
) {
  const requests: SesRequest[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization") ?? "",
      body: (await request.json()) as SesRequest["body"],
    });
    return answer();
  });
  return { requests, spy };
}

const refusal = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-amzn-ErrorType": `${type}:http://internal.amazon.com/coral/`,
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("sendMail", () => {
  it("sends through the binding while SES has no key, recipients as bare addresses", async () => {
    const { sent, EMAIL } = binding();
    const result = await sendMail({ EMAIL, SES_REGION: "eu-west-1" }, MAIL);
    expect(result).toEqual({
      transport: "email-service",
      id: "<cf1@example.com>",
      messageId: "<cf1@example.com>",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: "support@example.com", name: "Acme Support" },
      to: ["jane@example.org", "bob@example.org"],
      replyTo: "support+t1@example.com",
      subject: "Re: Your question",
      text: "Hello",
      html: "<p>Hello</p>",
      headers: {
        "In-Reply-To": "<q1@example.org>",
        References: "<q0@example.org> <q1@example.org>",
      },
      attachments: [
        {
          filename: "log.txt",
          type: "text/plain",
          content: btoa("log"),
          disposition: "attachment",
        },
        {
          filename: "logo.png",
          type: "image/png",
          content: btoa("png"),
          disposition: "inline",
          contentId: "logo1",
        },
      ],
    });
  });

  it("sends through SES once it has a key, signed for its region, and names SES's Message-ID", async () => {
    const { sent, EMAIL } = binding();
    const ses = fakeSes();
    const result = await sendMail({ EMAIL, ...SES }, { ...MAIL, tags: { kind: "reply" } });
    expect(result).toEqual({
      transport: "ses",
      id: "0107-abc-000000",
      messageId: "<0107-abc-000000@eu-west-1.amazonses.com>",
    });
    expect(sent).toEqual([]);
    expect(ses.requests).toHaveLength(1);
    const [request] = ses.requests;
    expect(request!.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(request!.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\/\d{8}\/eu-west-1\/ses\/aws4_request, /,
    );
    expect(request!.body).toMatchObject({
      FromEmailAddress: '"Acme Support" <support@example.com>',
      Destination: { ToAddresses: ['"Jane Doe" <jane@example.org>', "bob@example.org"] },
      ReplyToAddresses: ["support+t1@example.com"],
      EmailTags: [{ Name: "kind", Value: "reply" }],
      Content: {
        Simple: {
          Subject: { Data: "Re: Your question", Charset: "UTF-8" },
          Body: { Text: { Data: "Hello" }, Html: { Data: "<p>Hello</p>" } },
          Headers: [
            { Name: "In-Reply-To", Value: "<q1@example.org>" },
            { Name: "References", Value: "<q0@example.org> <q1@example.org>" },
          ],
          Attachments: [
            { FileName: "log.txt", RawContent: btoa("log"), ContentDisposition: "ATTACHMENT" },
            {
              FileName: "logo.png",
              RawContent: btoa("png"),
              ContentType: "image/png",
              ContentId: "logo1",
              ContentDisposition: "INLINE",
            },
          ],
        },
      },
    });
    expect(request!.body.ConfigurationSetName).toBeUndefined();
  });

  it("reports nothing to the Email SDK's telemetry", async () => {
    // The SDK stays quiet by itself under NODE_ENV=test or an opt-out in the environment: none of those here.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DO_NOT_TRACK", "");
    vi.stubEnv("EMAIL_SDK_TELEMETRY", "");
    const ses = fakeSes();
    await sendMail(SES, MAIL);
    expect(ses.requests.map((r) => new URL(r.url).host)).toEqual(["email.eu-west-1.amazonaws.com"]);
    // Importing the package turned it off for the whole process.
    expect(getTelemetryStatus()).toMatchObject({ enabled: false, reason: "code" });
  });

  it("hands a message SES refused to the binding and says why", async () => {
    const { sent, EMAIL } = binding();
    fakeSes(() => refusal(403, "AccessDeniedException", "not authorized to perform ses:SendEmail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await sendMail({ EMAIL, ...SES }, MAIL);
    expect(result.transport).toBe("email-service");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({
      event: "mail.ses_refused",
      status: 403,
      code: "AccessDeniedException",
    });
  });

  it("keeps SES's refusal when there is no binding to fall back on", async () => {
    fakeSes(() => refusal(400, "MessageRejected", "Email address is not verified."));
    const err = await sendMail(SES, MAIL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({
      transport: "ses",
      status: 400,
      code: "MessageRejected",
      message: "Email address is not verified.",
    });
    expect((err as MailError).refusedMessage).toBe(true);
  });

  it("never sends again through the binding when SES may have taken the message", async () => {
    const { sent, EMAIL } = binding();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(sendMail({ EMAIL, ...SES }, MAIL)).rejects.toMatchObject({
      transport: "ses",
      status: undefined,
      message: "fetch failed",
    });
    expect(sent).toEqual([]);
  });

  it("answers the binding's failure with its code", async () => {
    const { EMAIL } = binding(
      Object.assign(new Error("daily limit"), { code: "E_DAILY_LIMIT_EXCEEDED" }),
    );
    await expect(sendMail({ EMAIL }, MAIL)).rejects.toMatchObject({
      name: "MailError",
      transport: "email-service",
      code: "E_DAILY_LIMIT_EXCEEDED",
      message: "daily limit",
    });
  });

  it("addresses a message to Bcc alone To its sender, and one without recipients nowhere", async () => {
    const { sent, EMAIL } = binding();
    const bccOnly = { ...MAIL, to: [], bcc: ["boss@example.org"], attachments: [] };
    await sendMail({ EMAIL }, bccOnly);
    expect(sent[0]).toMatchObject({ to: ["support@example.com"], bcc: ["boss@example.org"] });
    await expect(sendMail({ EMAIL }, { ...bccOnly, bcc: [] })).rejects.toMatchObject({
      name: "MailError",
      code: "validation_error",
    });
    expect(sent).toHaveLength(1);
  });

  it("refuses to send without SES or the binding", async () => {
    expect(canSendMail({})).toBe(false);
    expect(canSendMail({ SES_REGION: "eu-west-1", SES_ACCESS_KEY_ID: "k" })).toBe(false);
    expect(canSendMail(SES)).toBe(true);
    await expect(sendMail({}, MAIL)).rejects.toBeInstanceOf(MailError);
  });
});

describe("sendWithSes", () => {
  it("names the configuration set and never falls back", async () => {
    const ses = fakeSes(() =>
      refusal(429, "TooManyRequestsException", "Maximum sending rate exceeded."),
    );
    await expect(
      sendWithSes(SES_CONFIG, MAIL, { configurationSet: "newsletter" }),
    ).rejects.toMatchObject({
      status: 429,
      code: "TooManyRequestsException",
      refusedMessage: false,
    });
    expect(ses.requests[0]!.body.ConfigurationSetName).toBe("newsletter");
  });

  it("sends a long thread's References within the 996 characters SES takes for a header", async () => {
    const ses = fakeSes();
    const ids = Array.from(
      { length: 16 },
      (_, i) => `<m${String(i).padStart(2, "0")}-${"x".repeat(43)}@example.org>`,
    );
    // Within the 995 characters SES takes for a value, beyond the 996 it takes for the name and value together.
    expect(ids.join(" ")).toHaveLength(991);
    await sendWithSes(SES_CONFIG, { ...MAIL, headers: { References: ids.join(" ") } });
    const [header] = ses.requests[0]!.body.Content.Simple.Headers!;
    expect(header!.Name.length + header!.Value.length).toBeLessThanOrEqual(996);
    expect(header!.Value).toBe([ids[0], ...ids.slice(2)].join(" "));
  });
});

describe("addresses and headers for SES", () => {
  it("quotes a name, or MIME-encodes one that is not ASCII", () => {
    expect(formatSesAddress("jane@example.org")).toBe("jane@example.org");
    expect(formatSesAddress("Jane <jane@example.org>")).toBe('"Jane" <jane@example.org>');
    expect(formatSesAddress({ email: "a@b.c", name: 'Say "hi"' })).toBe('"Say \\"hi\\"" <a@b.c>');
    expect(formatSesAddress({ email: "a@b.c", name: "Zoë" })).toBe("=?UTF-8?B?Wm/Dqw==?= <a@b.c>");
    expect(formatSesAddress({ email: "a@b.c", name: null })).toBe("a@b.c");
  });

  it("keeps a long References within what SES takes for it: the first and the latest", () => {
    const ids = Array.from(
      { length: 40 },
      (_, i) => `<message-${String(i).padStart(2, "0")}@mail.example.com>`,
    );
    const fitted = fitReferences(ids.join(" "));
    expect(fitted.length).toBeLessThanOrEqual(986);
    const kept = fitted.split(" ");
    expect(kept[0]).toBe(ids[0]);
    expect(kept.at(-1)).toBe(ids.at(-1));
    expect(kept.slice(1)).toEqual(ids.slice(ids.length - (kept.length - 1)));
    expect(fitReferences("<a@b> <c@d>")).toBe("<a@b> <c@d>");
    expect(fitReferences(ids.join(" "), 2048)).toBe(ids.join(" "));
  });

  it("names SES's Message-ID at the region's sending domain", () => {
    expect(sesMessageId("eu-west-1", "0107-x-000000")).toBe(
      "<0107-x-000000@eu-west-1.amazonses.com>",
    );
    expect(sesMessageId("us-east-1", "0100-x-000000")).toBe("<0100-x-000000@email.amazonses.com>");
  });
});
