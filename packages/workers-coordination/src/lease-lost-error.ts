/** The error `Lease.renew()` throws when the lease ended before the holder renewed it. */

/** The lease ended before its holder renewed it: another caller may hold the key now. */
export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
  /** The key whose lease ended. */
  readonly key: string;

  constructor(key: string) {
    super(`The lease on "${key}" has ended`);
    this.key = key;
  }
}
