/** The checks the package narrows PostHog's own payloads with, at the boundary it reads them. */

/** Whether `value` is a string. */
export const isString = (value: unknown): value is string =>
  typeof value === "string";

/**
 * Whether `value` is a plain object: one an event's properties, a `$set` or the SDK's cookie can
 * hold. A `Date`, a class instance or a `null` prototype's holder is not one.
 */
export const isPlainObject = (
  value: unknown
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the shape a JSON payload has before anything parses it
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
