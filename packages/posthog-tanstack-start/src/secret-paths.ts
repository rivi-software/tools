import { isPlainObject, isString } from "./guards.js";

/** Replaces every address of an app's secret paths in a text with the route pattern it matched. */
export type PathRedactor = (text: string) => string;

// A path segment as it can appear in a URL, an attribute or a message: it ends at the next separator or quote.
const SEGMENT = String.raw`([^/?#\s"'<>\\]+)`;

// The rest of a path, slashes included, which a splat matches: it ends at the query, the fragment or a quote.
const REST = String.raw`([^?#\s"'<>\\]+)`;

// Everything a regular expression reads as syntax, so a pattern's fixed parts match as written.
const SYNTAX = /[.*+?^${}()|[\]\\]/gu;

// The characters the router reads a parameter by. A fixed part with one in it was meant as a parameter.
const PARAMETER = /[${}]/u;

// Fixed text around `{$name}`, an optional `{-$name}` or a splat `{$}`: one of them per part, as the router reads it.
const BRACES =
  /^(?<prefix>[^${}]*)\{(?<optional>-?)\$(?<name>[^${}]*)\}(?<suffix>[^${}]*)$/u;

/** One part of a pattern between two slashes, as TanStack Router reads it. */
type Part =
  | { kind: "fixed"; text: string }
  // One segment (`$token`, `ticket-{$id}.pdf`), which an optional one (`{-$token}`) may leave out.
  | { kind: "segment"; prefix: string; suffix: string; optional: boolean }
  // The rest of the path: `$`, or `{$}` with fixed text around it, which may go on past the next slash.
  | { kind: "splat"; prefix: string; suffix: string; bare: boolean };

/** `part` as the router reads it, or null when the router would match it as fixed text that was meant as a parameter. */
const readPart = (part: string): Part | null => {
  if (part === "$") {
    return { kind: "splat", prefix: "", suffix: "", bare: true };
  }

  if (part.startsWith("$")) {
    // The router names the parameter after everything that follows the `$` (`$token.pdf` too), and matches the whole segment.
    return { kind: "segment", prefix: "", suffix: "", optional: false };
  }

  const braces = BRACES.exec(part)?.groups;

  if (braces) {
    const { prefix = "", optional, name, suffix = "" } = braces;

    if (optional) {
      // The router reads `{-$}` as fixed text: an optional parameter needs a name.
      return name ? { kind: "segment", prefix, suffix, optional: true } : null;
    }

    return name
      ? { kind: "segment", prefix, suffix, optional: false }
      : { kind: "splat", prefix, suffix, bare: false };
  }

  return PARAMETER.test(part) ? null : { kind: "fixed", text: part };
};

const fixed = (text: string) => text.replaceAll(SYNTAX, "\\$&");

/** The regular expression for `pattern`, and how many groups it captures: one for each parameter. */
const compile = (pattern: string) => {
  // An index route's trailing slash (`/t/$token/`) is optional, as the router matches it.
  const trailingSlash = pattern.length > 1 && pattern.endsWith("/");
  let source = "";
  let captures = 0;
  // What a splat leaves room for after it: the router reads what follows `{$}` as fixed text, and ignores what follows `$`.
  let after: "anything" | "fixed" | "nothing" = "anything";

  for (const [index, text] of (trailingSlash ? pattern.slice(0, -1) : pattern)
    .split("/")
    .entries()) {
    const part = readPart(text);

    if (!part) {
      throw new Error(
        `Secret path "${pattern}" has a part TanStack Router reads as fixed text: "${text}". A part is fixed text, $name, $, or fixed text around one {$name}, {-$name} or {$}.`
      );
    }

    if (after === "nothing" || (after === "fixed" && part.kind !== "fixed")) {
      throw new Error(
        `Secret path "${pattern}" goes on after its splat, which matches the rest of the path: nothing can follow $, and only fixed text can follow {$}.`
      );
    }

    const slash = index === 0 ? "" : "/";

    if (part.kind === "fixed") {
      source += slash + fixed(part.text);
    } else {
      const segment = `${slash}${fixed(part.prefix)}${part.kind === "splat" ? REST : SEGMENT}${fixed(part.suffix)}`;
      source +=
        part.kind === "segment" && part.optional ? `(?:${segment})?` : segment;
      captures += 1;

      if (part.kind === "splat") {
        after = part.bare ? "nothing" : "fixed";
      }
    }
  }

  return {
    // An app's own route patterns: each fixed part is escaped, and only a parameter becomes a pattern.
    // nosemgrep: detect-non-literal-regexp
    regex: new RegExp(
      trailingSlash ? `${source}/?` : source,
      // TanStack Router matches a route in any case by default, so `/T/3f9a…` opens the page too;
      // redacting too much is the safe side.
      "giu"
    ),
    captures,
  };
};

/**
 * Compiles the route patterns whose address is a credential, as TanStack Router writes them: a shared ticket at `/t/$token` is
 * read and answered by whoever holds its link. A parameter is the secret: `$token` or `{$token}` is one segment,
 * which may have fixed text around the braces (`ticket-{$id}.pdf`); `{-$token}` is one segment or none; and a splat,
 * `$` or `{$}`, is the rest of the path, slashes included. The rest must match as written, so `/t/3f9a…` becomes
 * `/t/$token`, and a page under one (`/u/<token>/confirm`) keeps what follows. A pattern the router would read
 * differently, such as `prefix$id` (fixed text to the router), throws.
 */
export const pathRedactor = (patterns: readonly string[]): PathRedactor => {
  const rules = patterns.map((pattern) => ({ pattern, ...compile(pattern) }));

  return (text) => {
    let redacted = text;

    for (const { pattern, regex, captures } of rules) {
      // The groups come first, then the match's offset and the whole text.
      redacted = redacted.replaceAll(
        regex,
        (match, ...groups: (string | number | undefined)[]) =>
          // A match without a parameter holds no secret: `/t` in `/tickets`, for `/t/{-$token}`.
          groups.slice(0, captures).some(isString) ? pattern : match
      );
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
