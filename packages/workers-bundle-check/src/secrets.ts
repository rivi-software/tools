import { createHash } from "node:crypto";

import { describePattern, moduleMatcher } from "./modules.js";
import type { ModulePattern } from "./modules.js";

/** The shape of a kind of secret, by the name reports give it. */
export interface SecretPattern {
  /** What reports call a value it matches: `Stripe secret key`. */
  name: string;
  /** What the value looks like. It must not match an empty string. */
  pattern: RegExp;
}

/**
 * The key formats the check looks for. Each has a prefix or a structure of its own, so text that
 * merely looks random does not match. Public keys that apps ship to browsers on purpose, such as
 * Stripe's `pk_` keys and Google's `AIza` API keys, are not in the list.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: "private key",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\\+[nr]|\s)+[A-Za-z0-9+/=]{40,}/u,
  },
  // AWS's documentation and SDKs use IDs that end in EXAMPLE.
  {
    name: "AWS access key ID",
    pattern: /\b(?:AKIA|ASIA)(?![A-Z2-7]{9}EXAMPLE)[A-Z2-7]{16}\b/u,
  },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{82})\b/u,
  },
  { name: "GitLab token", pattern: /\bglpat-[\w-]{20,}/u },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/u },
  { name: "Slack token", pattern: /\bxox[abeprs]-\d+-[A-Za-z0-9-]{10,}/u },
  {
    name: "Slack webhook URL",
    pattern:
      /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[\w+/-]{30,}/u,
  },
  {
    name: "Stripe secret key",
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/u,
  },
  { name: "webhook signing secret", pattern: /\bwhsec_[A-Za-z0-9+/=]{24,}/u },
  { name: "OpenAI API key", pattern: /\bsk-[\w-]{20,}T3BlbkFJ[\w-]{20,}/u },
  {
    name: "Anthropic API key",
    pattern: /\bsk-ant-(?:api|admin)\d\d-[\w-]{80,}/u,
  },
  { name: "PostHog personal API key", pattern: /\bphx_[A-Za-z0-9]{20,}/u },
  { name: "PostHog project secret key", pattern: /\bphs_[A-Za-z0-9]{20,}/u },
  { name: "Supabase secret key", pattern: /\bsb_secret_[\w-]{20,}/u },
  { name: "SendGrid API key", pattern: /\bSG\.[\w-]{22}\.[\w-]{43}\b/u },
  {
    name: "Shopify access token",
    pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/u,
  },
  { name: "Linear API key", pattern: /\blin_api_[A-Za-z0-9]{40}\b/u },
  { name: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{34,}\b/u },
  // Cloudflare's prefixed formats: 40 alphanumeric characters, then a checksum of 8 hex digits.
  // A Global API key is cfk_, a user API token cfut_ and an account API token cfat_.
  {
    name: "Cloudflare API credential",
    pattern: /\bcf(?:k|ut|at)_[A-Za-z0-9]{40}[a-f0-9]{8}\b/u,
  },
  {
    name: "Cloudflare Access service token secret",
    pattern: /\bcfast_[A-Za-z0-9]{40}[a-f0-9]{8}\b/u,
  },
];

/**
 * A finding known to be safe, such as a library's example key. It names the finding's
 * fingerprint, the module the value came from, or both, and must match a finding: an entry that
 * matches none is reported, so the list stays current.
 */
export interface AllowedSecret {
  /** The fingerprint the report gives the finding. */
  fingerprint?: string;
  /** The module the value comes from, as the file's source map says: see {@link ModulePattern}. */
  module?: ModulePattern;
  /** Why it is safe, for whoever reads the configuration next. */
  reason: string;
}

/** A value shaped like a secret in a built file. */
export interface SecretFinding {
  /** The pattern's name. */
  name: string;
  /** The first 16 hexadecimal digits of the value's SHA-256. The value itself is never reported. */
  fingerprint: string;
  /** The line it is on, from 1. */
  line: number;
  /** Its column on the line, from 0. */
  column: number;
}

/** The fingerprint a finding of `value` gets. */
export const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The index each line of `text` starts at, from the first. */
const lineStarts = (text: string): number[] => {
  const starts = [0];

  for (
    let index = text.indexOf("\n");
    index >= 0;
    index = text.indexOf("\n", index + 1)
  ) {
    starts.push(index + 1);
  }

  return starts;
};

/** The 0-based line that holds `index`. */
const lineOf = (starts: readonly number[], index: number): number => {
  let low = 0;
  let high = starts.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if ((starts[middle] ?? 0) <= index) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
};

/** Every value in `text` that one of the patterns matches. */
export const findSecrets = (
  text: string,
  patterns: readonly SecretPattern[]
): SecretFinding[] => {
  const findings: SecretFinding[] = [];
  let lines: number[] | undefined;

  for (const { name, pattern } of patterns) {
    const global = new RegExp(
      pattern.source,
      `${pattern.flags.replaceAll(/[gy]/gu, "")}g`
    );

    for (const match of text.matchAll(global)) {
      if (!match[0]) {
        continue;
      }

      lines ??= lineStarts(text);
      const line = lineOf(lines, match.index);
      findings.push({
        name,
        fingerprint: fingerprint(match[0]),
        line: line + 1,
        column: match.index - (lines[line] ?? 0),
      });
    }
  }

  return findings.toSorted((a, b) => a.line - b.line || a.column - b.column);
};

/** Whether an allowed entry covers a finding, given the module the finding comes from. */
export const allows = (
  allowed: AllowedSecret,
  finding: SecretFinding,
  module?: string
): boolean =>
  (allowed.fingerprint === undefined ||
    allowed.fingerprint === finding.fingerprint) &&
  (allowed.module === undefined ||
    (module !== undefined && moduleMatcher(allowed.module)(module)));

/** An allowed entry as reports name it. */
export const describeAllowed = (entry: AllowedSecret): string =>
  [
    entry.fingerprint === undefined
      ? undefined
      : `fingerprint ${entry.fingerprint}`,
    entry.module === undefined
      ? undefined
      : `module ${describePattern(entry.module)}`,
  ]
    .filter(Boolean)
    .join(" and ");

/** Throws when an entry names neither a fingerprint nor a module, or has no reason. */
export const validateAllowedSecrets = (
  allowed: readonly AllowedSecret[]
): void => {
  for (const entry of allowed) {
    if (entry.fingerprint === undefined && entry.module === undefined) {
      throw new TypeError(
        `An allowed secret names neither a fingerprint nor a module (${entry.reason}).`
      );
    }

    if (!entry.reason?.trim()) {
      throw new TypeError(
        `An allowed secret has no reason: ${describeAllowed(entry)}.`
      );
    }
  }
};

/** Throws when a secret pattern has no name, or matches the empty string. */
export const validateSecretPatterns = (
  patterns: readonly SecretPattern[]
): void => {
  for (const { name, pattern } of patterns) {
    if (!name?.trim() || !(pattern instanceof RegExp)) {
      throw new TypeError(
        `A secret pattern needs a name and a regular expression: ${name}.`
      );
    }

    if (
      new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/gu, "")).test(
        ""
      )
    ) {
      throw new TypeError(
        `The secret pattern ${name} matches an empty string.`
      );
    }
  }
};
