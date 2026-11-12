import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import { findSecrets, fingerprint, SECRET_PATTERNS } from "../src/secrets.js";

/**
 * A value of each kind, put together at run time so that no secret scanner finds one in this
 * repository. None is a real key.
 */
const join = (...parts: string[]) => parts.join("");

const alnum = (length: number) =>
  "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY".repeat(8).slice(0, length);

/** A Cloudflare credential whose last 8 characters are the CRC32 of the 40 before them. */
const withChecksum = (prefix: string, body = alnum(40)) =>
  join(prefix, body, crc32(body).toString(16).padStart(8, "0"));

/** The value with its last hexadecimal digit changed. */
const offByOne = (value: string) =>
  `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;

const SAMPLES = {
  "private key": join(
    "-----BEGIN ",
    "RSA PRIVATE KEY-----\n",
    "MIIEpAIBAAKCAQEA",
    alnum(48)
  ),
  "AWS access key ID": join("AK", "IA", "Q3EGRBXHLZ2KQ7MT"),
  "GitHub token": join("gh", "p_", alnum(36)),
  "GitLab token": join("gl", "pat-", alnum(20)),
  "npm token": join("np", "m_", alnum(36)),
  "Slack token": join(
    "xo",
    "xb-",
    "123456789012-",
    "1234567890123-",
    alnum(24)
  ),
  "Slack webhook URL": join(
    "https://hooks.",
    "slack.com/services/",
    "T0000000/B0000000/",
    alnum(24)
  ),
  "Stripe secret key": join("sk", "_live_", alnum(24)),
  "webhook signing secret": join("wh", "sec_", alnum(32)),
  "OpenAI API key": join("sk-", "proj-", alnum(24), "T3Blbk", "FJ", alnum(24)),
  "Anthropic API key": join("sk-", "ant-", "api03-", alnum(93)),
  "PostHog personal API key": join("ph", "x_", alnum(43)),
  "PostHog project secret key": join("ph", "s_", alnum(43)),
  "Supabase secret key": join("sb", "_secret_", alnum(32)),
  "SendGrid API key": join("S", "G.", alnum(22), ".", alnum(43)),
  "Shopify access token": join("sh", "pat_", "0123456789abcdef".repeat(2)),
  "Linear API key": join("li", "n_api_", alnum(40)),
  "Hugging Face token": join("h", "f_", alnum(34)),
  "Cloudflare API credential": withChecksum(join("cf", "ut_")),
  "Cloudflare Access service token secret": withChecksum(join("cf", "ast_")),
} satisfies Record<string, string>;

describe("the secret patterns", () => {
  it("has a sample for each pattern", () => {
    expect(Object.keys(SAMPLES)).toStrictEqual(
      SECRET_PATTERNS.map(({ name }) => name)
    );
  });

  it.for(Object.entries(SAMPLES))(
    "finds a %s in a string of built code",
    ([name, value]) => {
      const code = `var a="x",b=${JSON.stringify(value)};export{b as key};`;
      expect(
        findSecrets(code, SECRET_PATTERNS).map((finding) => finding.name)
      ).toStrictEqual([name]);
    }
  );

  it("passes keys meant to be public, and what only looks like a key", () => {
    const code = [
      // Stripe's publishable key
      join("pk", "_live_", alnum(24)),
      // a Google API key, which browser apps ship
      join("AIza", alnum(35)),
      // PostHog's project token, which is public
      join("phc_", alnum(43)),
      join("sb_publishable_", alnum(32)),
      // AWS's documented example
      join("AK", "IA", "IOSFODNN7EXAMPLE"),
      // a PEM parser's constant, with no key after it
      "-----BEGIN PRIVATE KEY-----",
      // ends in sk_test_ inside a word
      "task_test_abcdefghijklmnopqrstuvwxyz",
      "xoxo-and-goodbye-to-everyone",
    ].join("\n");

    expect(findSecrets(code, SECRET_PATTERNS)).toStrictEqual([]);
  });

  it.for(["k", "ut", "at"])(
    "finds a Cloudflare API credential that starts cf%s_",
    (kind) => {
      const value = withChecksum(join("cf", kind, "_"));
      expect(
        findSecrets(`const t=${JSON.stringify(value)};`, SECRET_PATTERNS).map(
          ({ name }) => name
        )
      ).toStrictEqual(["Cloudflare API credential"]);
    }
  );

  it("passes what is a character off a Cloudflare credential", () => {
    const code = [
      // prefixes Cloudflare does not issue
      withChecksum(join("cf", "x_")),
      withChecksum(join("cf", "as_")),
      // a body a character short, or a character long
      withChecksum(join("cf", "ut_"), alnum(39)),
      withChecksum(join("cf", "ast_"), alnum(39)),
      withChecksum(join("cf", "at_"), alnum(41)),
      // a checksum that is not hexadecimal
      join("cf", "k_", alnum(40), "3f9a0c7z"),
      // the prefix inside a word
      join("x", withChecksum(join("cf", "ut_"))),
    ].join("\n");

    expect(findSecrets(code, SECRET_PATTERNS)).toStrictEqual([]);
  });

  it.for([
    ["ut", "Cloudflare API credential"],
    ["at", "Cloudflare API credential"],
    ["ast", "Cloudflare Access service token secret"],
  ])(
    "finds a cf%s_ value whose checksum holds, and passes one whose checksum is wrong",
    ([kind, name]) => {
      const value = withChecksum(join("cf", kind, "_"));

      expect(
        findSecrets(
          `const a=${JSON.stringify(value)},b=${JSON.stringify(offByOne(value))};`,
          SECRET_PATTERNS
        )
      ).toStrictEqual([
        expect.objectContaining({ name, fingerprint: fingerprint(value) }),
      ]);
    }
  );

  it("finds a Global API key by its shape alone", () => {
    const value = offByOne(withChecksum(join("cf", "k_")));

    expect(
      findSecrets(`const t=${JSON.stringify(value)};`, SECRET_PATTERNS).map(
        ({ name }) => name
      )
    ).toStrictEqual(["Cloudflare API credential"]);
  });

  it("leaves out a match that its pattern's verify rejects", () => {
    const pattern = {
      name: "service token",
      pattern: /\bsvc_[a-z]\b/u,
      verify: (value: string) => value !== "svc_b",
    };

    expect(
      findSecrets("svc_a svc_b svc_c", [pattern]).map(({ column }) => column)
    ).toStrictEqual([0, 12]);
  });

  it("finds a private key written over lines, or escaped twice", () => {
    const pem = SAMPLES["private key"];

    for (const code of [
      `const k = \`${pem}\`;`,
      JSON.stringify(JSON.stringify({ private_key: pem })),
    ]) {
      expect(
        findSecrets(code, SECRET_PATTERNS).map(({ name }) => name)
      ).toStrictEqual(["private key"]);
    }
  });

  it("gives each finding its line, column and fingerprint, but never the value", () => {
    const value = SAMPLES["Stripe secret key"];

    const findings = findSecrets(
      `a();\nb();\n  const k="${value}";`,
      SECRET_PATTERNS
    );

    expect(findings).toStrictEqual([
      {
        name: "Stripe secret key",
        fingerprint: fingerprint(value),
        line: 3,
        column: 11,
      },
    ]);
    expect(fingerprint(value)).toMatch(/^[0-9a-f]{16}$/u);
  });
});
