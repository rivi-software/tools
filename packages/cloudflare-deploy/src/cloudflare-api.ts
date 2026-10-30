/**
 * A thin client for the Cloudflare v4 REST API: the account resources a Workers app creates at
 * runtime (D1 databases, KV namespaces, R2 buckets) and scripts in a Workers for Platforms
 * dispatch namespace. It only uses `fetch`, `FormData` and `Blob`, so it runs in a Worker as well
 * as in Node; import it as `@rivi-software/cloudflare-deploy/cloudflare-api` from Worker code, which keeps
 * the package's Node process helpers out of the bundle.
 *
 * Every call checks the HTTP status and the envelope's `success` flag. A failure throws
 * `CloudflareApiError` with the status and Cloudflare's error codes, never the token. Lookups
 * answer `undefined` for a 404 so callers can tell "missing" from "failed". With `retry`, a
 * request that is safe to repeat is sent again while Cloudflare answers 429 or 5xx.
 */

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export type CloudflareError = { code: number; message: string };

export class CloudflareApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly errors: CloudflareError[],
  ) {
    super(
      `Cloudflare ${method} ${path} failed (HTTP ${status}${errors.length ? `, ${errors.map((error) => error.code).join(", ")}` : ""})`,
    );
  }

  /** Whether Cloudflare reported this error code. */
  has(code: number) {
    return this.errors.some((error) => error.code === code);
  }
}

export type CloudflareApiOptions = {
  accountId: string;
  token: string;
  /** The transport; tests pass a fake API. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Sends a read, a replacing write or a delete up to `attempts` times while Cloudflare answers
   * 429 or 5xx (a passing `internal error`, code 10000) or the request fails on the way, pausing
   * `delayMs` (default 1 s) before the second try and twice as long before each next one. A
   * create is never sent twice. Off by default; a deploy script turns it on.
   */
  retry?: { attempts: number; delayMs?: number; sleep?: (ms: number) => Promise<void> };
};

/** Data residency for D1, KV and R2 (`cf-r2-jurisdiction` for R2). */
export type Jurisdiction = "eu" | "fedramp" | "us";

/** D1 primary location and R2 location hints. */
export type LocationHint = "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";

export type D1DatabaseInfo = {
  uuid: string;
  name: string;
  jurisdiction?: string | null;
  read_replication?: { mode: string } | null;
};

export type KvNamespaceInfo = { id: string; title: string };

/** One pair of a bulk write; a binary value goes base64-encoded with `base64: true`. */
export type KvEntry = { key: string; value: string; base64?: boolean; metadata?: unknown };

export type R2BucketInfo = { name: string; jurisdiction?: string; location?: string };

export type R2LifecycleRule = {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  deleteObjectsTransition?: { condition: { type: "Age"; maxAge: number } };
  abortMultipartUploadsTransition?: { condition: { type: "Age"; maxAge: number } };
};

export type R2LockRule = {
  id: string;
  enabled: boolean;
  prefix?: string;
  condition: { type: "Age"; maxAgeSeconds: number } | { type: "Indefinite" };
};

/** A Worker binding in upload metadata (the subset this client's callers send). */
export type WorkerBinding =
  // Upload metadata names the database `id` (what Wrangler sends), unlike `wrangler.json`.
  | { type: "d1"; name: string; id: string }
  | { type: "kv_namespace"; name: string; namespace_id: string }
  | { type: "r2_bucket"; name: string; bucket_name: string; jurisdiction?: Jurisdiction }
  | { type: "durable_object_namespace"; name: string; class_name: string }
  | { type: "ai"; name: string }
  | { type: "images"; name: string }
  | { type: "analytics_engine"; name: string; dataset: string }
  | { type: "plain_text"; name: string; text: string };

export type DurableObjectMigrationStep = {
  new_sqlite_classes?: string[];
  deleted_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
};

export type WorkerMetadata = {
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  bindings: WorkerBinding[];
  /** Binding types the new version keeps from the previous one (secrets set out of band). */
  keep_bindings?: string[];
  tags?: string[];
  /** Workers that receive the script's trace events (Tail Workers). */
  tail_consumers?: { service: string }[];
  migrations?: { old_tag?: string; new_tag: string; steps: DurableObjectMigrationStep[] };
  limits?: { cpu_ms?: number; subrequests?: number };
};

export type WorkerModule = {
  name: string;
  content: string | ArrayBuffer | Uint8Array;
  /** `application/javascript+module`, `application/wasm`, `text/plain`, … */
  type: string;
};

export type WorkerUpload = { metadata: WorkerMetadata; modules: WorkerModule[] };

export type NamespaceScript = {
  script: { id: string; migration_tag?: string | null; tags?: string[] | null };
};

/** One script of a namespace listing. */
export type NamespaceScriptSummary = {
  id: string;
  tags?: string[] | null;
  migration_tag?: string | null;
  modified_on?: string;
};

export type D1Export = { signedUrl: string; filename: string };

type Envelope<T> = {
  success?: boolean;
  errors?: CloudflareError[];
  result?: T;
  result_info?: {
    page?: number;
    total_pages?: number;
    total_count?: number;
    count?: number;
    cursor?: string;
  };
};

type CallOptions = {
  json?: unknown;
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** A POST that changes nothing more when sent twice, such as a bulk delete. */
  idempotent?: boolean;
};

/** Methods whose request changes nothing more when sent twice. */
const IDEMPOTENT_METHODS = new Set(["GET", "PUT", "DELETE"]);

/** Cloudflare's answers when the API, not the request, failed. */
const isTransient = (status: number) => status === 429 || status >= 500;

const jurisdictionHeader = (jurisdiction?: Jurisdiction | null): Record<string, string> =>
  jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {};

export function cloudflareApi(options: CloudflareApiOptions) {
  const transport = options.fetch ?? ((input, init) => fetch(input, init));
  const account = `/accounts/${options.accountId}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep =
    options.retry?.sleep ?? ((ms: number) => new Promise((settle) => setTimeout(settle, ms)));

  async function request(method: string, path: string, init: CallOptions = {}) {
    const url = new URL(`${CLOUDFLARE_API}${account}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      ...init.headers,
    };
    let body: FormData | string | undefined;
    if (init.form) body = init.form;
    else if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const repeatable = init.idempotent || IDEMPOTENT_METHODS.has(method);
    const attempts = repeatable ? (options.retry?.attempts ?? 1) : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await transport(url.toString(), {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (attempt >= attempts || !isTransient(response.status)) return response;
        await response.body?.cancel();
      } catch (error) {
        if (attempt >= attempts) throw error;
      }
      await sleep((options.retry?.delayMs ?? 1000) * 2 ** (attempt - 1));
    }
  }

  async function send<T>(method: string, path: string, init: CallOptions = {}) {
    const response = await request(method, path, init);
    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
    return { response, envelope };
  }

  async function call<T>(method: string, path: string, init: CallOptions = {}): Promise<T> {
    const { response, envelope } = await send<T>(method, path, init);
    if (!response.ok || !envelope?.success)
      throw new CloudflareApiError(method, path, response.status, envelope?.errors ?? []);
    return envelope.result as T;
  }

  /** A call whose 404 means "not there": answers `undefined` instead of throwing. */
  async function maybe<T>(method: string, path: string, init: CallOptions = {}) {
    try {
      return await call<T>(method, path, init);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async function* pages<T>(
    path: string,
    perPage: number,
    query: Record<string, string | number | boolean | undefined> = {},
  ) {
    for (let page = 1; ; page++) {
      const { response, envelope } = await send<T[]>("GET", path, {
        query: { ...query, page, per_page: perPage },
      });
      if (!response.ok || !envelope?.success)
        throw new CloudflareApiError("GET", path, response.status, envelope?.errors ?? []);
      const items = envelope.result ?? [];
      yield* items;
      const info = envelope.result_info;
      const last =
        items.length < perPage ||
        (info?.total_pages !== undefined && page >= info.total_pages) ||
        (info?.total_count !== undefined && page * perPage >= info.total_count);
      if (last) return;
    }
  }

  const d1 = {
    /**
     * The database with exactly this name. The API's name filter is a search, so this pages
     * through every database whose name contains it (`app-a-1` … `app-a-150` beside `app-a`).
     */
    async find(name: string): Promise<D1DatabaseInfo | undefined> {
      for await (const database of pages<D1DatabaseInfo>("/d1/database", 100, { name }))
        if (database.name === name) return database;
      return undefined;
    },
    create(input: {
      name: string;
      jurisdiction?: Jurisdiction | null;
      primaryLocationHint?: LocationHint | null;
      readReplication?: boolean;
    }) {
      return call<D1DatabaseInfo>("POST", "/d1/database", {
        json: {
          name: input.name,
          ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
          ...(input.primaryLocationHint && !input.jurisdiction
            ? { primary_location_hint: input.primaryLocationHint }
            : {}),
          ...(input.readReplication ? { read_replication: { mode: "auto" } } : {}),
        },
      });
    },
    /** Turns on read replication (the Sessions API then routes reads to replicas). */
    enableReadReplication(databaseId: string) {
      return call<D1DatabaseInfo>("PATCH", `/d1/database/${databaseId}`, {
        json: { read_replication: { mode: "auto" } },
      });
    },
    /** Deletes the database; `false` when it was already gone. */
    async delete(databaseId: string) {
      return (await maybe<unknown>("DELETE", `/d1/database/${databaseId}`)) !== undefined;
    },
    /**
     * Exports the database as SQL and answers the signed download URL (valid for an hour). The
     * export is polled with its bookmark until it completes; one that is not polled is cancelled.
     */
    async export(
      databaseId: string,
      wait: { sleep?: (ms: number) => Promise<void>; attempts?: number; delayMs?: number } = {},
    ): Promise<D1Export> {
      const sleep = wait.sleep ?? ((ms) => new Promise((settle) => setTimeout(settle, ms)));
      let bookmark: string | undefined;
      for (let attempt = 0; attempt < (wait.attempts ?? 60); attempt++) {
        const poll = await call<{
          at_bookmark?: string;
          status?: string;
          error?: string;
          result?: { signed_url?: string; filename?: string };
        }>("POST", `/d1/database/${databaseId}/export`, {
          json: { output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) },
        });
        if (poll.status === "error")
          throw new CloudflareApiError("POST", `/d1/database/${databaseId}/export`, 200, [
            { code: 0, message: poll.error ?? "Export failed" },
          ]);
        if (poll.status === "complete" && poll.result?.signed_url)
          return { signedUrl: poll.result.signed_url, filename: poll.result.filename ?? "" };
        bookmark = poll.at_bookmark ?? bookmark;
        await sleep(wait.delayMs ?? 1000);
      }
      throw new CloudflareApiError("POST", `/d1/database/${databaseId}/export`, 408, [
        { code: 0, message: "Export did not complete in time" },
      ]);
    },
  };

  const kv = {
    /** The namespace with this title; the API has no title filter, so this pages through. */
    async find(title: string): Promise<KvNamespaceInfo | undefined> {
      // 100 per page, as Wrangler pages; a larger page size is not documented as honoured.
      for await (const namespace of pages<KvNamespaceInfo>("/storage/kv/namespaces", 100))
        if (namespace.title === title) return namespace;
      return undefined;
    },
    create(input: { title: string; jurisdiction?: Jurisdiction | null }) {
      return call<KvNamespaceInfo>("POST", "/storage/kv/namespaces", {
        json: {
          title: input.title,
          ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
        },
      });
    },
    async delete(namespaceId: string) {
      return (
        (await maybe<unknown>("DELETE", `/storage/kv/namespaces/${namespaceId}`)) !== undefined
      );
    },
    /** Every key name under `prefix`, 1000 a page by the listing's cursor. */
    async listKeys(namespaceId: string, input: { prefix?: string } = {}) {
      const path = `/storage/kv/namespaces/${namespaceId}/keys`;
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const { response, envelope } = await send<{ name: string }[]>("GET", path, {
          query: { prefix: input.prefix, limit: 1000, cursor },
        });
        if (!response.ok || !envelope?.success)
          throw new CloudflareApiError("GET", path, response.status, envelope?.errors ?? []);
        for (const key of envelope.result ?? []) names.push(key.name);
        cursor = envelope.result_info?.cursor || undefined;
      } while (cursor);
      return names;
    },
    /** A value as text, or `undefined` when the key is missing. The API answers it raw. */
    async getText(namespaceId: string, key: string) {
      const path = `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
      const response = await request("GET", path);
      if (response.ok) return response.text();
      if (response.status === 404) return undefined;
      const envelope = (await response.json().catch(() => null)) as Envelope<unknown> | null;
      throw new CloudflareApiError("GET", path, response.status, envelope?.errors ?? []);
    },
    /** Writes up to 10,000 pairs in one request of at most 100 MB (the bulk API's limits). */
    putMany(namespaceId: string, entries: KvEntry[]) {
      return call<unknown>("PUT", `/storage/kv/namespaces/${namespaceId}/bulk`, { json: entries });
    },
    /** Deletes up to 10,000 keys; a key that is not there is no error. */
    deleteMany(namespaceId: string, keys: string[]) {
      return call<unknown>("POST", `/storage/kv/namespaces/${namespaceId}/bulk/delete`, {
        json: keys,
        idempotent: true,
      });
    },
  };

  const r2 = {
    get(name: string, jurisdiction?: Jurisdiction | null) {
      return maybe<R2BucketInfo>("GET", `/r2/buckets/${name}`, {
        headers: jurisdictionHeader(jurisdiction),
      });
    },
    create(input: {
      name: string;
      jurisdiction?: Jurisdiction | null;
      locationHint?: LocationHint | null;
    }) {
      return call<R2BucketInfo>("POST", "/r2/buckets", {
        headers: jurisdictionHeader(input.jurisdiction),
        // Under a jurisdiction the jurisdiction places the bucket; the hint is left out.
        json: {
          name: input.name,
          ...(input.locationHint && !input.jurisdiction
            ? { locationHint: input.locationHint }
            : {}),
        },
      });
    },
    /** Deletes an empty bucket; `false` when it was already gone (409 10008 when not empty). */
    async delete(name: string, jurisdiction?: Jurisdiction | null) {
      return (
        (await maybe<unknown>("DELETE", `/r2/buckets/${name}`, {
          headers: jurisdictionHeader(jurisdiction),
        })) !== undefined
      );
    },
    async getLifecycle(name: string, jurisdiction?: Jurisdiction | null) {
      const result = await call<{ rules?: R2LifecycleRule[] }>(
        "GET",
        `/r2/buckets/${name}/lifecycle`,
        { headers: jurisdictionHeader(jurisdiction) },
      );
      return result?.rules ?? [];
    },
    /** Replaces the bucket's lifecycle rules. */
    putLifecycle(name: string, rules: R2LifecycleRule[], jurisdiction?: Jurisdiction | null) {
      return call<unknown>("PUT", `/r2/buckets/${name}/lifecycle`, {
        headers: jurisdictionHeader(jurisdiction),
        json: { rules },
      });
    },
    async getLock(name: string, jurisdiction?: Jurisdiction | null) {
      const result = await call<{ rules?: R2LockRule[] }>("GET", `/r2/buckets/${name}/lock`, {
        headers: jurisdictionHeader(jurisdiction),
      });
      return result?.rules ?? [];
    },
    /** Replaces the bucket's lock rules. */
    putLock(name: string, rules: R2LockRule[], jurisdiction?: Jurisdiction | null) {
      return call<unknown>("PUT", `/r2/buckets/${name}/lock`, {
        headers: jurisdictionHeader(jurisdiction),
        json: { rules },
      });
    },
  };

  const scriptPath = (namespace: string, script: string) =>
    `/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(script)}`;

  const dispatch = {
    /**
     * The script, or `undefined` when the namespace has none by that name. The API answers a
     * missing script with `200` and `script: null` (seen on a production namespace), not `404`.
     */
    async getScript(namespace: string, script: string): Promise<NamespaceScript | undefined> {
      const found = await maybe<{ script: NamespaceScript["script"] | null }>(
        "GET",
        scriptPath(namespace, script),
      );
      return found?.script ? { script: found.script } : undefined;
    },
    /**
     * Every script of the namespace, or those carrying all of `tags` (the API's `tag:yes`
     * filter), paged 100 at a time.
     */
    async listScripts(namespace: string, input: { tags?: string[] } = {}) {
      const path = `/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts`;
      const scripts: NamespaceScriptSummary[] = [];
      const query = input.tags?.length
        ? { tags: input.tags.map((tag) => `${tag}:yes`).join(",") }
        : {};
      for await (const script of pages<NamespaceScriptSummary>(path, 100, query))
        scripts.push(script);
      return scripts;
    },
    /** Uploads a User Worker (multipart: `metadata` plus one part per module). */
    uploadScript(namespace: string, script: string, upload: WorkerUpload) {
      const form = new FormData();
      form.append(
        "metadata",
        new Blob([JSON.stringify(upload.metadata)], { type: "application/json" }),
      );
      for (const module of upload.modules)
        form.append(
          module.name,
          new Blob([module.content as string | ArrayBuffer], { type: module.type }),
          module.name,
        );
      return call<{ id?: string; etag?: string; migration_tag?: string; tags?: string[] }>(
        "PUT",
        scriptPath(namespace, script),
        { form },
      );
    },
    /**
     * Deletes a script; with `force` its Durable Object namespaces go with it. `false` when it
     * was already gone.
     */
    async deleteScript(namespace: string, script: string, input: { force?: boolean } = {}) {
      return (
        (await maybe<unknown>("DELETE", scriptPath(namespace, script), {
          query: { force: input.force ? true : undefined },
        })) !== undefined
      );
    },
    /**
     * Sets one secret on the script (a new version of it, deployed at once); setting the same
     * value again is harmless, so a caller may set it on every release.
     */
    putSecret(namespace: string, script: string, secret: { name: string; text: string }) {
      return call<{ name: string; type: string }>(
        "PUT",
        `${scriptPath(namespace, script)}/secrets`,
        {
          json: { ...secret, type: "secret_text" },
        },
      );
    },
    /** Replaces the script's tags. */
    putTags(namespace: string, script: string, tags: string[]) {
      return call<string[]>("PUT", `${scriptPath(namespace, script)}/tags`, { json: tags });
    },
  };

  return { call, maybe, d1, kv, r2, dispatch };
}

export type CloudflareApi = ReturnType<typeof cloudflareApi>;
