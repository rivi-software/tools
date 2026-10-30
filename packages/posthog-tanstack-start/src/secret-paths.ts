/** Replaces every address of an app's secret paths in a text with the route pattern it matched. */
export type PathRedactor = (text: string) => string;

// A path segment as it can appear in a URL, an attribute or a message: it ends at the next separator or quote.
const SEGMENT = String.raw`[^/?#\s"'<>\\]+`;

/**
 * Compiles the route patterns whose address is a credential, as TanStack Router writes them: a shared ticket at `/t/$token` is
 * read and answered by whoever holds its link. Each `$` segment is the secret and the
 * rest must match as written, so `/t/3f9a…` becomes `/t/$token`, and a page under one (`/u/<token>/confirm`) keeps
 * what follows.
 */
export function pathRedactor(patterns: readonly string[]): PathRedactor {
  const rules = patterns.map((pattern) => ({
    pattern,
    // An app's own route patterns: each literal part is escaped, and only a `$` segment becomes a pattern.
    // nosemgrep: detect-non-literal-regexp
    regex: new RegExp(
      pattern
        .split("/")
        .map((part) =>
          part.startsWith("$") ? SEGMENT : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/"),
      "g",
    ),
  }));
  return (text) =>
    rules.reduce((out, { pattern, regex }) => out.replace(regex, () => pattern), text);
}

/** `value` with `redact` applied to every string in it, object keys included (heatmaps key their data by URL). */
export function redactDeep<T>(value: T, redact: PathRedactor): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T;
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactDeep(item, redact)]),
    ) as T;
  return value;
}
