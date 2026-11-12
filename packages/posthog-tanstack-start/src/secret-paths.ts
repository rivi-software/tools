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

// What an object or array that holds itself holds there instead, as posthog-node's JSON writes a cycle.
const CIRCULAR = "[Circular]";

/**
 * `value` with `redact` applied to every string in it. `path` holds the arrays and objects that contain `value`, so a
 * reference back to one of them ends the walk, and one that only appears twice is redacted in both places.
 */
const redactWithin = <T>(
  value: T,
  redact: PathRedactor,
  path: Set<object>
): T => {
  if (isString(value)) {
    // SAFETY: `redact` answers a string for a string, so the result is the same `T` that came in.
    return redact(value) as T;
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    return value;
  }

  if (path.has(value)) {
    // SAFETY: a cycle is the one place the shape changes; JSON cannot write it, and the SDK would write this string.
    return CIRCULAR as T;
  }

  path.add(value);

  const redacted = Array.isArray(value)
    ? value.map((item) => redactWithin(item, redact, path))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redact(key),
          redactWithin(item, redact, path),
        ])
      );

  path.delete(value);

  // SAFETY: an array or a plain object with every key and item redacted keeps the shape it came in with.
  return redacted as T;
};

/**
 * `value` with `redact` applied to every string in it, object keys included (heatmaps key their data by URL). An
 * object or array that holds itself holds `"[Circular]"` there instead, so an event with a cycle still goes.
 */
export const redactDeep = <T>(value: T, redact: PathRedactor): T =>
  redactWithin(value, redact, new Set());
