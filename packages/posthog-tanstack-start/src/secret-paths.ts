import { isPlainObject, isString } from "./guards.js";

/** Replaces every address of an app's secret paths in a text with the route pattern it matched. */
export type PathRedactor = (text: string) => string;

// A path segment as it can appear in a URL, an attribute or a message: it ends at the next separator or quote.
const SEGMENT = String.raw`[^/?#\s"'<>\\]+`;

// Everything a regular expression reads as syntax, so a pattern's fixed parts match as written.
const SYNTAX = /[.*+?^${}()|[\]\\]/gu;

/**
 * Compiles the route patterns whose address is a credential, as TanStack Router writes them: a shared ticket at `/t/$token` is
 * read and answered by whoever holds its link. Each `$` segment is the secret and the
 * rest must match as written, so `/t/3f9a…` becomes `/t/$token`, and a page under one (`/u/<token>/confirm`) keeps
 * what follows.
 */
export const pathRedactor = (patterns: readonly string[]): PathRedactor => {
  const rules = patterns.map((pattern) => ({
    pattern,
    // An app's own route patterns: each literal part is escaped, and only a `$` segment becomes a pattern.
    // nosemgrep: detect-non-literal-regexp
    regex: new RegExp(
      pattern
        .split("/")
        .map((part) =>
          part.startsWith("$") ? SEGMENT : part.replaceAll(SYNTAX, "\\$&")
        )
        .join("/"),
      // TanStack Router matches a route in any case by default, so `/T/3f9a…` opens the page too;
      // redacting too much is the safe side.
      "giu"
    ),
  }));

  return (text) => {
    let redacted = text;

    for (const { pattern, regex } of rules) {
      redacted = redacted.replaceAll(regex, () => pattern);
    }

    return redacted;
  };
};

/** `value` with `redact` applied to every string in it, object keys included (heatmaps key their data by URL). */
export const redactDeep = <T>(value: T, redact: PathRedactor): T => {
  if (isString(value)) {
    // SAFETY: `redact` answers a string for a string, so the result is the same `T` that came in.
    return redact(value) as T;
  }

  if (Array.isArray(value)) {
    // SAFETY: an array of redacted items is the same array type as the one that came in.
    return value.map((item) => redactDeep(item, redact)) as T;
  }

  if (isPlainObject(value)) {
    // SAFETY: a plain object with every key and item redacted keeps the shape it came in with.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key),
        redactDeep(item, redact),
      ])
    ) as T;
  }

  return value;
};
