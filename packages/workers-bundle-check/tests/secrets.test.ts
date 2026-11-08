import { describe, expect, it } from "vitest";

import { findSecrets, fingerprint, SECRET_PATTERNS } from "../src/secrets.js";

/**
 * A value of each kind, put together at run time so that no secret scanner finds one in this
 * repository. None is a real key.
 */
const join = (...parts: string[]) => parts.join("");

const alnum = (length: number) =>
  "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY".repeat(8).slice(0, length);

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
