/** What the two Durable Objects and their clients share: the namespace a client takes, and clean-up. */

/**
 * The part of a Durable Object namespace binding the clients use: one object for each name.
 * `DurableObjectNamespace<RateLimiter>` and `DurableObjectNamespace<LeaseLock>` have it.
 */
export interface DurableObjectNamespaceLike<Id, Stub> {
  /** The id of the object for `name`: the same name gives the same object. */
  idFromName: (name: string) => Id;
  /** A stub for the object with `id`, whose methods call the object. */
  get: (id: Id) => Stub;
}

/** The object for `key`. A new stub for each call: a stub that saw an error can stay broken. */
export const objectFor = <Id, Stub>(
  namespace: DurableObjectNamespaceLike<Id, Stub>,
  key: string
) => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a published entry point: JavaScript callers can pass anything, and the TypeError is part of its behaviour
  if (typeof key !== "string" || key === "") {
    throw new TypeError("The key must be a non-empty string");
  }

  return namespace.get(namespace.idFromName(key));
};

/** The storage calls `forget` makes. */
export interface ForgettableStorage {
  /** Deletes the object's alarm. */
  deleteAlarm: () => Promise<void>;
  /** Deletes everything the object stored. */
  deleteAll: () => Promise<void>;
}

/**
 * Empties an object's storage, its alarm included. An object whose storage is empty stops
 * existing once it shuts down, so an idle key costs nothing. `deleteAll()` deletes the alarm
 * too from compatibility date 2026-02-24 on; `deleteAlarm()` first covers earlier dates.
 */
export const forget = async (storage: ForgettableStorage): Promise<void> => {
  await storage.deleteAlarm();
  await storage.deleteAll();
};
