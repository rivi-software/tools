/**
 * An in-memory Workers KV namespace for tests. It also models what a local KV leaves out: each
 * Cloudflare location caches what it reads. A read keeps the value, or its absence, for `cacheTtl`
 * seconds (60 by default). A write is visible at once in the location that made it, and elsewhere
 * only once that location's cached copy runs out. `location()` hands out another location over the
 * same storage, so a test can write in one location and read stale data in another.
 *
 * It enforces KV's limits with errors worded like the runtime's: keys of 1 to 512 bytes other than
 * `.` and `..`, values up to 25 MiB, metadata up to 1024 bytes of JSON, `cacheTtl` of at least 30,
 * an expiry at least 60 seconds out, up to 100 keys in a bulk read and up to 1000 keys a page.
 */

export type KvValueType = "text" | "json" | "arrayBuffer" | "stream";

/** The options of a read; `type` defaults to `text`. */
export interface KvReadOptions<Type extends KvValueType = KvValueType> {
  type?: Type;
  /** Seconds this location keeps what it read; at least 30. Default 60. */
  cacheTtl?: number;
}

export interface KvPutOptions {
  /** When the key expires, in seconds since the epoch; at least 60 seconds from now. */
  expiration?: number;
  /** Seconds until the key expires; at least 60. */
  expirationTtl?: number;
  /** Up to 1024 bytes once serialized as JSON. */
  metadata?: unknown;
}

export interface KvListOptions {
  prefix?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface KvListKey<Metadata = unknown> {
  name: string;
  expiration?: number;
  metadata?: Metadata;
}

export type KvListResult<Metadata = unknown> =
  | {
      list_complete: false;
      keys: KvListKey<Metadata>[];
      cursor: string;
      cacheStatus: null;
    }
  | { list_complete: true; keys: KvListKey<Metadata>[]; cacheStatus: null };

export interface KvValueWithMetadata<Value, Metadata> {
  value: Value | null;
  metadata: Metadata | null;
  cacheStatus: null;
}

/** How often a location's methods were called, and how many reads missed its cache. */
export interface KvOperations {
  get: number;
  put: number;
  delete: number;
  list: number;
  /** Keys read from storage because this location had no live cached copy. */
  coldReads: number;
}

export interface MemoryKvOptions {
  /** The clock, in milliseconds. Default `Date.now`, read on each call so fake timers move it. */
  now?: () => number;
}

interface Entry {
  bytes: Uint8Array<ArrayBuffer>;
  metadata: unknown;
  expiration: number | null;
}

interface Shared {
  entries: Map<string, Entry>;
  now: () => number;
  failingPuts: number;
}

type Text = { type?: "text"; cacheTtl?: number } | "text";

type Json = { type: "json"; cacheTtl?: number } | "json";

type Binary = { type: "arrayBuffer"; cacheTtl?: number } | "arrayBuffer";

type Stream = { type: "stream"; cacheTtl?: number } | "stream";

const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024;
const MIN_CACHE_TTL = 30;
const DEFAULT_CACHE_TTL = 60;
const MIN_EXPIRATION_TTL = 60;
const MAX_BULK_KEYS = 100;
const MAX_LIST_LIMIT = 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isString = (value: unknown): value is string => typeof value === "string";

const isValueType = (
  options: KvReadOptions | KvValueType | undefined
): options is KvValueType => typeof options === "string";

const readOptions = (options?: KvReadOptions | KvValueType) => {
  let settings: KvReadOptions = {};

  if (isValueType(options)) {
    settings = { type: options };
  } else if (options) {
    settings = options;
  }

  const cacheTtl = settings.cacheTtl ?? DEFAULT_CACHE_TTL;

  if (!Number.isInteger(cacheTtl) || cacheTtl < MIN_CACHE_TTL) {
    throw new Error(
      `KV GET failed: 400 Invalid cache_ttl of ${cacheTtl}. Cache TTL must be at least ${MIN_CACHE_TTL}.`
    );
  }

  const type = settings.type ?? "text";

  if (!["text", "json", "arrayBuffer", "stream"].includes(type)) {
    throw new TypeError(
      `Unknown response type "${type}". Possible types are "text", "json", "arrayBuffer" and "stream".`
    );
  }

  return { type, cacheTtl };
};

const checkKey = (operation: string, key: string) => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the KV runtime refuses a non-string key, which an untyped caller can still pass
  if (typeof key !== "string") {
    throw new TypeError(`KV ${operation} failed: a key must be a string.`);
  }

  if (key === "") {
    throw new TypeError(
      `KV ${operation} failed: 400 Key names must not be empty.`
    );
  }

  if (key === "." || key === "..") {
    throw new TypeError(
      `KV ${operation} failed: 400 Illegal key name "${key}". Please use a different name.`
    );
  }

  const length = encoder.encode(key).byteLength;

  if (length > MAX_KEY_BYTES) {
    throw new Error(
      `KV ${operation} failed: 414 UTF-8 encoded length of ${length} exceeds key length limit of ${MAX_KEY_BYTES}.`
    );
  }
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- KvPutOptions.metadata is anything JSON can hold, as the KV runtime takes it
const copyMetadata = (metadata: unknown) => {
  if (metadata === undefined) {
    return null;
  }

  const json = JSON.stringify(metadata);
  const length = encoder.encode(json).byteLength;

  if (length > MAX_METADATA_BYTES) {
    throw new Error(
      `KV PUT failed: 413 Metadata length of ${length} exceeds limit of ${MAX_METADATA_BYTES}.`
    );
  }

  const copy: unknown = JSON.parse(json);

  return copy;
};

const toBytes = async (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the runtime refuses an unsupported value at this boundary, which untyped callers also reach
  value: unknown
): Promise<Uint8Array<ArrayBuffer>> => {
  if (isString(value)) {
    return encoder.encode(value);
  }

  if (value instanceof ArrayBuffer) {
    // oxlint-disable-next-line unicorn/prefer-spread -- this is ArrayBuffer#slice, which copies the buffer; spreading it would not
    return new Uint8Array(value.slice(0));
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    ).slice();
  }

  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }

  throw new TypeError(
    "KV put() accepts only strings, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values."
  );
};

// oxlint-disable-next-line anti-slop/no-unknown-returns -- what a read answers is whatever was stored, and `type` decides its shape
const decode = (entry: Entry | null, type: KvValueType): unknown => {
  if (!entry) {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- the caller's overload names the type; here it is still whatever was stored
    return null;
  }

  if (type === "json") {
    return JSON.parse(decoder.decode(entry.bytes));
  }

  if (type === "arrayBuffer") {
    // oxlint-disable-next-line unicorn/prefer-spread -- this is TypedArray#slice, which copies the bytes; spreading would make a number array
    return entry.bytes.slice().buffer;
  }

  if (type === "stream") {
    return new Blob([entry.bytes]).stream();
  }

  return decoder.decode(entry.bytes);
};

const isExpired = (entry: Entry, now: number) =>
  entry.expiration !== null && entry.expiration * 1000 <= now;

/** KV orders keys by their UTF-8 bytes, which is code point order, not UTF-16 order. */
export const compareKeys = (a: string, b: string) => {
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return left.length - right.length;
};

/** An opaque cursor: the last key of the page, base64-encoded. */
export const encodeCursor = (key: string) =>
  btoa(String.fromCodePoint(...encoder.encode(key)));

export const decodeCursor = (cursor: string) => {
  try {
    return decoder.decode(
      Uint8Array.from(atob(cursor), (char) => char.codePointAt(0) ?? 0)
    );
  } catch {
    throw new Error(`KV LIST failed: 400 Invalid cursor "${cursor}".`);
  }
};

export class MemoryKv {
  /** How often this location's methods were called, and its cold reads. */
  readonly operations: KvOperations = {
    get: 0,
    put: 0,
    delete: 0,
    list: 0,
    coldReads: 0,
  };
  readonly #shared: Shared;
  readonly #cache = new Map<string, { entry: Entry | null; until: number }>();

  /**
   * Use `memoryKv()`, or `location()` for another location over the same storage.
   *
   * @internal
   */
  constructor(shared: Shared) {
    this.#shared = shared;
  }

  /** Another location over the same storage, with its own read cache and `operations`. */
  location(): MemoryKv {
    return new MemoryKv(this.#shared);
  }

  /** Every live key with its value as text, read from storage, past every location's cache. */
  dump(): Record<string, string> {
    const out: Record<string, string> = {};

    for (const name of this.#names("")) {
      out[name] = decoder.decode(this.#live(name)?.bytes);
    }

    // oxlint-disable-next-line anti-slop/no-known-value-widening -- the published signature maps every stored key, whichever they are, to its text
    return out;
  }

  /**
   * Makes the next `count` puts, in any location, throw `KV PUT failed: 429 Too Many Requests`,
   * as KV does past one write a second to a key.
   */
  failPuts(count: number) {
    this.#shared.failingPuts = count;
  }

  get(key: string, options?: Text): Promise<string | null>;
  get<Value = unknown>(key: string, options: Json): Promise<Value | null>;
  get(key: string, options: Binary): Promise<ArrayBuffer | null>;
  get(key: string, options: Stream): Promise<ReadableStream<Uint8Array> | null>;
  get(keys: string[], options?: Text): Promise<Map<string, string | null>>;
  get<Value = unknown>(
    keys: string[],
    options: Json
  ): Promise<Map<string, Value | null>>;
  // oxlint-disable-next-line eslint/require-await -- KVNamespace.get answers a promise, so a refused key must reject rather than throw
  async get(
    key: string | string[],
    options?: KvReadOptions | KvValueType
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- the implementation signature behind the typed overloads above
  ): Promise<unknown | Map<string, unknown>> {
    this.operations.get += 1;
    const { type, cacheTtl } = readOptions(options);

    if (Array.isArray(key)) {
      const entries = this.#readMany(key, type, cacheTtl);

      return new Map(
        [...entries].map(([name, entry]) => [name, decode(entry, type)])
      );
    }

    checkKey("GET", key);

    return decode(this.#read(key, cacheTtl), type);
  }

  getWithMetadata<Metadata = unknown>(
    key: string,
    options?: Text
  ): Promise<KvValueWithMetadata<string, Metadata>>;
  getWithMetadata<Value = unknown, Metadata = unknown>(
    key: string,
    options: Json
  ): Promise<KvValueWithMetadata<Value, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: Binary
  ): Promise<KvValueWithMetadata<ArrayBuffer, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: Stream
  ): Promise<KvValueWithMetadata<ReadableStream<Uint8Array>, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    keys: string[],
    options?: Text
  ): Promise<Map<string, KvValueWithMetadata<string, Metadata>>>;
  getWithMetadata<Value = unknown, Metadata = unknown>(
    keys: string[],
    options: Json
  ): Promise<Map<string, KvValueWithMetadata<Value, Metadata>>>;
  // oxlint-disable-next-line eslint/require-await -- KVNamespace.getWithMetadata answers a promise, so a refused key must reject rather than throw
  async getWithMetadata(
    key: string | string[],
    options?: KvReadOptions | KvValueType
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- the implementation signature behind the typed overloads above
  ): Promise<unknown> {
    this.operations.get += 1;
    const { type, cacheTtl } = readOptions(options);

    const withMetadata = (entry: Entry | null) => ({
      value: decode(entry, type),
      metadata: entry?.metadata ?? null,
      cacheStatus: null,
    });

    if (Array.isArray(key)) {
      const entries = this.#readMany(key, type, cacheTtl);

      return new Map(
        [...entries].map(([name, entry]) => [name, withMetadata(entry)])
      );
    }

    checkKey("GET", key);

    return withMetadata(this.#read(key, cacheTtl));
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options: KvPutOptions = {}
  ): Promise<void> {
    this.operations.put += 1;
    checkKey("PUT", key);
    const bytes = await toBytes(value);

    if (bytes.byteLength > MAX_VALUE_BYTES) {
      throw new Error(
        `KV PUT failed: 413 Value length of ${bytes.byteLength} exceeds limit of ${MAX_VALUE_BYTES}.`
      );
    }

    const metadata = copyMetadata(options.metadata);
    const expiration = this.#expiration(options);

    if (this.#shared.failingPuts > 0) {
      this.#shared.failingPuts -= 1;
      throw new Error("KV PUT failed: 429 Too Many Requests");
    }

    const entry = { bytes, metadata, expiration };
    this.#shared.entries.set(key, entry);
    this.#remember(key, entry);
  }

  // oxlint-disable-next-line eslint/require-await -- KVNamespace.delete answers a promise, so a refused key must reject rather than throw
  async delete(key: string): Promise<void> {
    this.operations.delete += 1;
    checkKey("DELETE", key);
    this.#shared.entries.delete(key);
    this.#remember(key, null);
  }

  /**
   * The live keys under `prefix` in UTF-8 byte order, `limit` (at most 1000) a page. Reads storage,
   * not this location's cache.
   */
  // oxlint-disable-next-line eslint/require-await -- KVNamespace.list answers a promise, so a refused limit or cursor must reject rather than throw
  async list<Metadata = unknown>(
    options: KvListOptions = {}
  ): Promise<KvListResult<Metadata>> {
    this.operations.list += 1;
    const limit = options.limit ?? MAX_LIST_LIMIT;

    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new Error(
        `KV LIST failed: 400 Invalid limit of ${limit}. The limit must be an integer from 1 to ${MAX_LIST_LIMIT}.`
      );
    }

    const after = options.cursor ? decodeCursor(options.cursor) : undefined;

    const names = this.#names(options.prefix ?? "").filter(
      (name) => after === undefined || compareKeys(name, after) > 0
    );

    const keys = names.slice(0, limit).map((name) => {
      // SAFETY: #names only answers keys whose entry is live, so #live cannot be null here
      const entry = this.#live(name) as Entry;
      const key: KvListKey<Metadata> = { name };

      if (entry.expiration !== null) {
        key.expiration = entry.expiration;
      }

      if (entry.metadata !== null) {
        // SAFETY: the caller names the metadata type it stored through this namespace
        key.metadata = entry.metadata as Metadata;
      }

      return key;
    });

    const last = keys.at(-1);

    // `last` is set whenever there are more names than the limit, so the cursor is always a key.
    if (names.length <= limit || !last) {
      return { list_complete: true, keys, cacheStatus: null };
    }

    return {
      list_complete: false,
      keys,
      cursor: encodeCursor(last.name),
      cacheStatus: null,
    };
  }

  /** The entry, or `null` once it expired (and then it is dropped from storage). */
  #live(key: string): Entry | null {
    const entry = this.#shared.entries.get(key);

    if (!entry) {
      return null;
    }

    if (isExpired(entry, this.#shared.now())) {
      this.#shared.entries.delete(key);

      return null;
    }

    return entry;
  }

  #names(prefix: string) {
    return [...this.#shared.entries.keys()]
      .filter((name) => name.startsWith(prefix) && this.#live(name) !== null)
      .toSorted(compareKeys);
  }

  /** Reads through this location's cache, which keeps a read for `cacheTtl` seconds. */
  #read(key: string, cacheTtl: number): Entry | null {
    const now = this.#shared.now();
    let cached = this.#cache.get(key);

    if (!cached || cached.until <= now) {
      this.operations.coldReads += 1;
      cached = { entry: this.#live(key), until: now + cacheTtl * 1000 };
      this.#cache.set(key, cached);
    }

    return cached.entry && !isExpired(cached.entry, now) ? cached.entry : null;
  }

  #readMany(keys: string[], type: KvValueType, cacheTtl: number) {
    if (type !== "text" && type !== "json") {
      throw new Error(
        `KV GET_BULK failed: 400 A bulk read answers "text" or "json", not "${type}".`
      );
    }

    if (keys.length > MAX_BULK_KEYS) {
      throw new Error(
        `KV GET_BULK failed: 400 A bulk read takes at most ${MAX_BULK_KEYS} keys, not ${keys.length}.`
      );
    }

    for (const key of keys) {
      checkKey("GET_BULK", key);
    }

    return new Map(keys.map((key) => [key, this.#read(key, cacheTtl)]));
  }

  /** A write or delete is visible at once in the location that made it. */
  #remember(key: string, entry: Entry | null) {
    this.#cache.set(key, {
      entry,
      until: this.#shared.now() + DEFAULT_CACHE_TTL * 1000,
    });
  }

  #expiration(options: KvPutOptions): number | null {
    const now = Math.floor(this.#shared.now() / 1000);

    if (options.expirationTtl !== undefined) {
      const ttl = options.expirationTtl;

      if (!Number.isFinite(ttl) || ttl <= 0) {
        throw new Error(
          `KV PUT failed: 400 Invalid expiration_ttl of ${ttl}. Please specify integer greater than 0.`
        );
      }

      if (ttl < MIN_EXPIRATION_TTL) {
        throw new Error(
          `KV PUT failed: 400 Invalid expiration_ttl of ${ttl}. Expiration TTL must be at least ${MIN_EXPIRATION_TTL}.`
        );
      }

      return now + Math.floor(ttl);
    }

    if (options.expiration !== undefined) {
      const { expiration } = options;

      if (!Number.isFinite(expiration) || expiration <= now) {
        throw new Error(
          `KV PUT failed: 400 Invalid expiration of ${expiration}. Please specify integer greater than the current number of seconds since the UNIX epoch.`
        );
      }

      if (expiration < now + MIN_EXPIRATION_TTL) {
        throw new Error(
          `KV PUT failed: 400 Invalid expiration of ${expiration}. Expiration times must be at least ${MIN_EXPIRATION_TTL} seconds in the future.`
        );
      }

      return Math.floor(expiration);
    }

    return null;
  }
}

/**
 * A KV namespace in memory, seen from one location. Bind it where a Worker expects a
 * `KVNamespace` (`memoryKv() as unknown as KVNamespace`), and keep the returned object for the
 * test hooks: `location()`, `operations`, `dump()` and `failPuts()`.
 */
export const memoryKv = (options: MemoryKvOptions = {}): MemoryKv =>
  new MemoryKv({
    entries: new Map(),
    now: options.now ?? (() => Date.now()),
    failingPuts: 0,
  });
