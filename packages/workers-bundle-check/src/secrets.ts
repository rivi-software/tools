import { createHash } from "node:crypto";
import { describePattern, moduleMatcher, type ModulePattern } from "./modules.js";

/** The shape of a kind of secret, by the name reports give it. */
export type SecretPattern = { name: string; pattern: RegExp };

/**
 * The key formats the check looks for. Each has a prefix or a structure of its own, so text that
 * merely looks random does not match. Public keys that apps ship to browsers on purpose, such as
 * Stripe's `pk_` keys and Google's `AIza` API keys, are not in the list.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: "private key",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\\+[nr]|\s)+[A-Za-z0-9+/=]{40,}/,
  },
  // AWS's documentation and SDKs use IDs that end in EXAMPLE.
  { name: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)(?![A-Z2-7]{9}EXAMPLE)[A-Z2-7]{16}\b/ },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{82})\b/ },
  { name: "GitLab token", pattern: /\bglpat-[\w-]{20,}/ },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "Slack token", pattern: /\bxox[abeprs]-\d+-[A-Za-z0-9-]{10,}/ },
  {
    name: "Slack webhook URL",
    pattern: /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[\w+/-]{30,}/,
  },
  { name: "Stripe secret key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: "webhook signing secret", pattern: /\bwhsec_[A-Za-z0-9+/=]{24,}/ },
  { name: "OpenAI API key", pattern: /\bsk-[\w-]{20,}T3BlbkFJ[\w-]{20,}/ },
  { name: "Anthropic API key", pattern: /\bsk-ant-(?:api|admin)\d\d-[\w-]{80,}/ },
  { name: "PostHog personal API key", pattern: /\bphx_[A-Za-z0-9]{20,}/ },
  { name: "PostHog project secret key", pattern: /\bphs_[A-Za-z0-9]{20,}/ },
  { name: "Supabase secret key", pattern: /\bsb_secret_[\w-]{20,}/ },
  { name: "SendGrid API key", pattern: /\bSG\.[\w-]{22}\.[\w-]{43}\b/ },
  { name: "Shopify access token", pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/ },
  { name: "Linear API key", pattern: /\blin_api_[A-Za-z0-9]{40}\b/ },
  { name: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{34,}\b/ },
];

/**
 * A finding known to be safe, such as a library's example key. It names the finding's
 * fingerprint, the module the value came from, or both, and must match a finding: an entry that
 * matches none is reported, so the list stays current.
 */
export type AllowedSecret = {
  /** The fingerprint the report gives the finding. */
  fingerprint?: string;
  /** The module the value comes from, as the file's source map says: see {@link ModulePattern}. */
  module?: ModulePattern;
  /** Why it is safe, for whoever reads the configuration next. */
  reason: string;
};

/** A value shaped like a secret in a built file. */
export type SecretFinding = {
  /** The pattern's name. */
  name: string;
  /** The first 16 hexadecimal digits of the value's SHA-256. The value itself is never reported. */
  fingerprint: string;
  /** The line it is on, from 1. */
  line: number;
  /** Its column on the line, from 0. */
  column: number;
};

/** Every value in `text` that one of the patterns matches. */
export function findSecrets(text: string, patterns: readonly SecretPattern[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let lines: number[] | undefined;
  for (const { name, pattern } of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}g`);
    for (const match of text.matchAll(global)) {
      if (!match[0]) continue;
      lines ??= lineStarts(text);
      const line = lineOf(lines, match.index);
      findings.push({
        name,
        fingerprint: fingerprint(match[0]),
        line: line + 1,
        column: match.index - lines[line]!,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The fingerprint a finding of `value` gets. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Whether an allowed entry covers a finding, given the module the finding comes from. */
export function allows(allowed: AllowedSecret, finding: SecretFinding, module?: string): boolean {
  return (
    (allowed.fingerprint === undefined || allowed.fingerprint === finding.fingerprint) &&
    (allowed.module === undefined ||
      (module !== undefined && moduleMatcher(allowed.module)(module)))
  );
}

/** Throws when an entry names neither a fingerprint nor a module, or has no reason. */
export function validateAllowedSecrets(allowed: readonly AllowedSecret[]): void {
  for (const entry of allowed) {
    if (entry.fingerprint === undefined && entry.module === undefined)
      throw new TypeError(
        `An allowed secret names neither a fingerprint nor a module (${entry.reason}).`,
      );
    if (!entry.reason?.trim())
      throw new TypeError(`An allowed secret has no reason: ${describeAllowed(entry)}.`);
  }
}

/** Throws when a secret pattern has no name, or matches the empty string. */
export function validateSecretPatterns(patterns: readonly SecretPattern[]): void {
  for (const { name, pattern } of patterns) {
    if (!name?.trim() || !(pattern instanceof RegExp))
      throw new TypeError(`A secret pattern needs a name and a regular expression: ${name}.`);
    if (new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(""))
      throw new TypeError(`The secret pattern ${name} matches an empty string.`);
  }
}

/** An allowed entry as reports name it. */
export function describeAllowed(entry: AllowedSecret): string {
  return [
    entry.fingerprint === undefined ? undefined : `fingerprint ${entry.fingerprint}`,
    entry.module === undefined ? undefined : `module ${describePattern(entry.module)}`,
  ]
    .filter(Boolean)
    .join(" and ");
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1))
    starts.push(index + 1);
  return starts;
}

/** The 0-based line that holds `index`. */
function lineOf(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  return low;
}
