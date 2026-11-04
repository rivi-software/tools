/**
 * A fake of the Cloudflare v4 REST API for tests, held in memory. It serves the endpoints
 * `cloudflareApi` calls for D1, KV, R2 and Workers for Platforms, and answers them with
 * Cloudflare's envelopes, statuses and error codes. Pass the fake as the client's options (it
 * carries `accountId`, `token` and `fetch`) or pass only its `fetch`.
 *
 * It keeps what exists in `state`, logs each call in `calls`, counts creates, and fails a call on
 * request (`failNext`). A test can then show that a retry after any failure creates nothing twice.
 * It also keeps the rules that catch real mistakes:
 * - Names are unique per account.
 * - Looking up something that is not there answers 404 with that resource's code.
 * - A missing dispatch script answers 200 with `script: null`.
 * - A Durable Object migration must name the script's current tag.
 * - An upload drops the script's secrets unless `keep_bindings` keeps them.
 */
import {
  CLOUDFLARE_API,
  type Jurisdiction,
  type LocationHint,
  type R2LifecycleRule,
  type R2LockRule,
  type WorkerMetadata,
} from "./cloudflare-api.js";
import { compareKeys, decodeCursor, encodeCursor } from "./memory-kv.js";

export type FakeD1Database = {
  uuid: string;
  name: string;
  jurisdiction: Jurisdiction | null;
  primaryLocationHint: LocationHint | null;
  readReplication: { mode: string };
  createdAt: string;
  /** The SQL an export of the database serves. Set it to give a test's export some content. */
  sql: string;
};

/** A stored KV value, as the bulk write sent it: text, or base64 with `base64: true`. */
export type FakeKvValue = { value: string; base64: boolean; metadata?: unknown };

export type FakeKvNamespace = {
  id: string;
  title: string;
  jurisdiction: Jurisdiction | null;
  values: Map<string, FakeKvValue>;
};

export type FakeR2Bucket = {
  name: string;
  /** `default` for a bucket created without the `cf-r2-jurisdiction` header. */
  jurisdiction: Jurisdiction | "default";
  location: LocationHint | null;
  createdAt: string;
  lifecycle: R2LifecycleRule[];
  lock: R2LockRule[];
  /** How many objects the bucket holds. A bucket that holds any cannot be deleted (409, 10008). */
  objects: number;
};

export type FakeScriptModule = { type: string; bytes: Uint8Array<ArrayBuffer>; text: string };

export type FakeScript = {
  namespace: string;
  name: string;
  metadata: WorkerMetadata;
  modules: Map<string, FakeScriptModule>;
  migrationTag: string | null;
  /** The script's Durable Object classes after its migrations: created, renamed and deleted. */
  durableObjectClasses: string[];
  tags: string[];
  /** Secret values by name, whether set with the secrets endpoint or as `secret_text` bindings. */
  secrets: Map<string, string>;
  /** How many uploads made this script, the first included. */
  uploads: number;
  etag: string;
  createdOn: string;
  modifiedOn: string;
};

export type FakeCloudflareApiOptions = {
  /** The account the fake serves. Default 32 `f`s. Calls to another account answer 403 (9109). */
  accountId?: string;
  /**
   * The only token the fake accepts. Any other answers 403 (10000). By default it accepts any
   * bearer token.
   */
  token?: string;
  /** The clock for creation and modification times, in milliseconds. Default `Date.now`. */
  now?: () => number;
};

export type FakeFailure = {
  /** The status to answer. Default 500. */
  status?: number;
  /** The Cloudflare error code to answer. Default 10000. */
  code?: number;
  message?: string;
  /** Rejects the request as a network failure does, instead of answering. */
  network?: boolean;
  /** Carries the call out first, then fails: a response lost after Cloudflare acted. */
  apply?: boolean;
  /** How many matching calls fail. Default 1. */
  times?: number;
  /** How many matching calls go through before the first one fails. Default 0. */
  skip?: number;
};

type Failure = Required<Omit<FakeFailure, "message">> & {
  method: string;
  pattern: RegExp;
  message: string;
};

type Call = {
  request: Request;
  url: URL;
  params: Record<string, string>;
  /** The R2 jurisdiction the `cf-r2-jurisdiction` header names, or `default`. */
  jurisdiction: Jurisdiction | "default";
};

type Route = [
  method: string,
  pattern: string,
  handle: (call: Call) => Promise<Response> | Response,
];

/** A malformed request body: answered 400 with this code and message. */
class BadRequest extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const API_ORIGIN = new URL(CLOUDFLARE_API).origin;
const API_PREFIX = `${new URL(CLOUDFLARE_API).pathname}/accounts/`;
/** Where finished D1 exports are served. `.test` is reserved, so nothing real answers there. */
const EXPORT_ORIGIN = "https://d1-exports.fake-cloudflare.test";
const R2_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * A Cloudflare API in memory. Use it with the client:
 *
 * ```ts
 * const fake = createFakeCloudflareApi();
 * const api = cloudflareApi(fake);
 * await api.d1.create({ name: "app" });
 * expect(fake.state.d1.databases.map((database) => database.name)).toEqual(["app"]);
 * ```
 */
export function createFakeCloudflareApi(options: FakeCloudflareApiOptions = {}) {
  const accountId = options.accountId ?? "f".repeat(32);
  const token = options.token ?? "fake-cloudflare-token";
  const now = options.now ?? (() => Date.now());
  const timestamp = () => new Date(now()).toISOString();
  const state = {
    d1: { databases: [] as FakeD1Database[] },
    kv: { namespaces: [] as FakeKvNamespace[] },
    r2: { buckets: [] as FakeR2Bucket[] },
    dispatch: { scripts: [] as FakeScript[] },
  };
  /** Successful creates of each kind; a script counts once, at its first upload. */
  const creates = { d1: 0, kv: 0, r2: 0, scripts: 0 };
  /** Each call that reached the account, as `METHOD /path` under `/accounts/<id>`. */
  const calls: string[] = [];
  const failures: Failure[] = [];
  const exports = new Map<string, { filename: string; sql: string }>();
  let sequence = 0;
  const next = () => ++sequence;
  const uuid = () => `00000000-0000-4000-8000-${next().toString(16).padStart(12, "0")}`;
  const hexId = () => next().toString(16).padStart(32, "0");

  const ok = (result: unknown, extra: object = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string) =>
    Response.json(
      { success: false, errors: [{ code, message }], messages: [], result: null },
      { status },
    );

  async function json<T>(request: Request): Promise<T> {
    try {
      return (await request.json()) as T;
    } catch {
      throw new BadRequest(6007, "Malformed JSON in request body");
    }
  }

  function page<T>(url: URL, items: T[], fallback: number) {
    const number = Math.max(1, Math.floor(Number(url.searchParams.get("page") ?? 1)) || 1);
    const perPage = Math.max(
      1,
      Math.floor(Number(url.searchParams.get("per_page") ?? fallback)) || fallback,
    );
    const slice = items.slice((number - 1) * perPage, number * perPage);
    return ok(slice, {
      result_info: {
        page: number,
        per_page: perPage,
        count: slice.length,
        total_count: items.length,
      },
    });
  }

  // D1

  const databaseInfo = (database: FakeD1Database) => ({
    uuid: database.uuid,
    name: database.name,
    version: "production",
    created_at: database.createdAt,
    jurisdiction: database.jurisdiction,
    read_replication: { ...database.readReplication },
  });
  const findDatabase = (id: string) => state.d1.databases.find((item) => item.uuid === id);
  const noDatabase = (id: string) => fail(404, 7404, `The database ${id} could not be found`);

  const d1Routes: Route[] = [
    // The name filter is a search: `app` also finds `app-2`.
    [
      "GET",
      "/d1/database",
      ({ url }) => {
        const name = url.searchParams.get("name") ?? "";
        const found = state.d1.databases.filter((item) => item.name.includes(name));
        return page(url, found.map(databaseInfo), 1000);
      },
    ],
    [
      "POST",
      "/d1/database",
      async ({ request }) => {
        const body = await json<{
          name?: string;
          jurisdiction?: Jurisdiction;
          primary_location_hint?: LocationHint;
          read_replication?: { mode: string };
        }>(request);
        if (!body.name) return fail(400, 7400, "The request is malformed: name is required");
        if (state.d1.databases.some((item) => item.name === body.name))
          return fail(400, 7502, "A database with that name already exists");
        const database: FakeD1Database = {
          uuid: uuid(),
          name: body.name,
          jurisdiction: body.jurisdiction ?? null,
          primaryLocationHint: body.primary_location_hint ?? null,
          readReplication: { mode: body.read_replication?.mode ?? "disabled" },
          createdAt: timestamp(),
          sql: "",
        };
        state.d1.databases.push(database);
        creates.d1 += 1;
        return ok(databaseInfo(database));
      },
    ],
    [
      "GET",
      "/d1/database/:id",
      ({ params }) => {
        const database = findDatabase(params.id);
        return database ? ok(databaseInfo(database)) : noDatabase(params.id);
      },
    ],
    [
      "PATCH",
      "/d1/database/:id",
      async ({ params, request }) => {
        const database = findDatabase(params.id);
        if (!database) return noDatabase(params.id);
        const body = await json<{ read_replication?: { mode?: string } }>(request);
        const mode = body.read_replication?.mode;
        if (mode !== undefined && mode !== "auto" && mode !== "disabled")
          return fail(400, 7400, `The request is malformed: unknown read_replication mode ${mode}`);
        if (mode) database.readReplication = { mode };
        return ok(databaseInfo(database));
      },
    ],
    [
      "DELETE",
      "/d1/database/:id",
      ({ params }) => {
        const database = findDatabase(params.id);
        if (!database) return noDatabase(params.id);
        state.d1.databases.splice(state.d1.databases.indexOf(database), 1);
        return ok(null);
      },
    ],
    // The first poll starts the export and answers its bookmark; polling with it finishes.
    [
      "POST",
      "/d1/database/:id/export",
      async ({ params, request }) => {
        const database = findDatabase(params.id);
        if (!database) return noDatabase(params.id);
        const body = await json<{ output_format?: string; current_bookmark?: string }>(request);
        if (body.output_format !== "polling")
          return fail(400, 7400, "The request is malformed: output_format must be polling");
        const started = body.current_bookmark && exports.get(body.current_bookmark);
        if (!started) {
          const bookmark = `bookmark-${next()}`;
          exports.set(bookmark, {
            filename: `${database.uuid}-${bookmark}.sql`,
            sql: database.sql,
          });
          return ok({ type: "export", at_bookmark: bookmark, status: "active", messages: [] });
        }
        return ok({
          type: "export",
          at_bookmark: body.current_bookmark,
          status: "complete",
          messages: [],
          result: {
            filename: started.filename,
            signed_url: `${EXPORT_ORIGIN}/${body.current_bookmark}/${started.filename}`,
          },
        });
      },
    ],
  ];

  // KV

  const namespaceInfo = (namespace: FakeKvNamespace) => ({
    id: namespace.id,
    title: namespace.title,
    supports_url_encoding: true,
  });
  const findNamespace = (id: string) => state.kv.namespaces.find((item) => item.id === id);
  const noNamespace = () => fail(404, 10013, "namespace not found");

  const kvRoutes: Route[] = [
    [
      "GET",
      "/storage/kv/namespaces",
      ({ url }) => page(url, state.kv.namespaces.map(namespaceInfo), 20),
    ],
    [
      "POST",
      "/storage/kv/namespaces",
      async ({ request }) => {
        const body = await json<{ title?: string; jurisdiction?: Jurisdiction }>(request);
        if (!body.title) return fail(400, 10019, "title is required");
        if (state.kv.namespaces.some((item) => item.title === body.title))
          return fail(400, 10014, "A namespace with this account ID and title already exists.");
        const namespace: FakeKvNamespace = {
          id: hexId(),
          title: body.title,
          jurisdiction: body.jurisdiction ?? null,
          values: new Map(),
        };
        state.kv.namespaces.push(namespace);
        creates.kv += 1;
        return ok(namespaceInfo(namespace));
      },
    ],
    [
      "DELETE",
      "/storage/kv/namespaces/:id",
      ({ params }) => {
        const namespace = findNamespace(params.id);
        if (!namespace) return noNamespace();
        state.kv.namespaces.splice(state.kv.namespaces.indexOf(namespace), 1);
        return ok(null);
      },
    ],
    // Keys in UTF-8 byte order, `limit` a page; an empty cursor marks the last page.
    [
      "GET",
      "/storage/kv/namespaces/:id/keys",
      ({ params, url }) => {
        const namespace = findNamespace(params.id);
        if (!namespace) return noNamespace();
        const prefix = url.searchParams.get("prefix") ?? "";
        const limit = Math.min(1000, Math.max(10, Number(url.searchParams.get("limit")) || 1000));
        const cursor = url.searchParams.get("cursor");
        let after: string | undefined;
        try {
          after = cursor ? decodeCursor(cursor) : undefined;
        } catch {
          return fail(400, 10032, "Invalid cursor");
        }
        const names = [...namespace.values.keys()]
          .filter((name) => name.startsWith(prefix))
          .filter((name) => after === undefined || compareKeys(name, after) > 0)
          .sort(compareKeys);
        const keys = names.slice(0, limit).map((name) => {
          const metadata = namespace.values.get(name)?.metadata;
          return metadata === undefined ? { name } : { name, metadata };
        });
        const more = names.length > limit;
        return ok(keys, {
          result_info: {
            count: keys.length,
            cursor: more ? encodeCursor(keys[keys.length - 1].name) : "",
          },
        });
      },
    ],
    // The value, raw; a missing key answers 404 with an envelope.
    [
      "GET",
      "/storage/kv/namespaces/:id/values/:key",
      ({ params }) => {
        const namespace = findNamespace(params.id);
        if (!namespace) return noNamespace();
        const stored = namespace.values.get(params.key);
        if (!stored) return fail(404, 10009, "get: 'key not found'");
        const bytes = stored.base64
          ? Uint8Array.from(atob(stored.value), (char) => char.charCodeAt(0))
          : new TextEncoder().encode(stored.value);
        return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      },
    ],
    [
      "PUT",
      "/storage/kv/namespaces/:id/bulk",
      async ({ params, request }) => {
        const namespace = findNamespace(params.id);
        if (!namespace) return noNamespace();
        const entries =
          await json<{ key: string; value: string; base64?: boolean; metadata?: unknown }[]>(
            request,
          );
        if (!Array.isArray(entries) || entries.length > 10_000)
          return fail(400, 10026, "The body must be an array of up to 10,000 key-value pairs");
        for (const entry of entries) {
          if (typeof entry?.key !== "string" || typeof entry.value !== "string")
            return fail(400, 10026, "Each pair needs a string key and a string value");
          namespace.values.set(entry.key, {
            value: entry.value,
            base64: entry.base64 === true,
            ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
          });
        }
        return ok({ successful_key_count: entries.length, unsuccessful_keys: [] });
      },
    ],
    [
      "POST",
      "/storage/kv/namespaces/:id/bulk/delete",
      async ({ params, request }) => {
        const namespace = findNamespace(params.id);
        if (!namespace) return noNamespace();
        const keys = await json<string[]>(request);
        if (!Array.isArray(keys) || keys.length > 10_000)
          return fail(400, 10026, "The body must be an array of up to 10,000 keys");
        for (const key of keys) namespace.values.delete(key);
        return ok({ successful_key_count: keys.length, unsuccessful_keys: [] });
      },
    ],
  ];

  // R2: a bucket is only found under the jurisdiction it was created in.

  const bucketInfo = (bucket: FakeR2Bucket) => ({
    name: bucket.name,
    creation_date: bucket.createdAt,
    ...(bucket.location ? { location: bucket.location.toUpperCase() } : {}),
    ...(bucket.jurisdiction === "default" ? {} : { jurisdiction: bucket.jurisdiction }),
    storage_class: "Standard",
  });
  const findBucket = ({ params, jurisdiction }: Call) =>
    state.r2.buckets.find(
      (item) => item.name === params.name && item.jurisdiction === jurisdiction,
    );
  const noBucket = () => fail(404, 10006, "The specified bucket does not exist.");
  const withBucket =
    (handle: (bucket: FakeR2Bucket, call: Call) => Promise<Response> | Response) =>
    (call: Call) => {
      const bucket = findBucket(call);
      return bucket ? handle(bucket, call) : noBucket();
    };
  const rules = async <T>(request: Request) => {
    const body = await json<{ rules?: T[] }>(request);
    if (!Array.isArray(body.rules)) throw new BadRequest(10040, "rules must be an array");
    return body.rules;
  };

  const r2Routes: Route[] = [
    [
      "POST",
      "/r2/buckets",
      async (call) => {
        const body = await json<{ name?: string; locationHint?: LocationHint }>(call.request);
        if (!body.name || !R2_BUCKET_NAME.test(body.name))
          return fail(400, 10005, "The specified bucket name is not valid.");
        if (findBucket({ ...call, params: { name: body.name } }))
          return fail(409, 10073, "The bucket you tried to create already exists, and you own it.");
        const bucket: FakeR2Bucket = {
          name: body.name,
          jurisdiction: call.jurisdiction,
          location: body.locationHint ?? null,
          createdAt: timestamp(),
          lifecycle: [],
          lock: [],
          objects: 0,
        };
        state.r2.buckets.push(bucket);
        creates.r2 += 1;
        return ok(bucketInfo(bucket));
      },
    ],
    ["GET", "/r2/buckets/:name", withBucket((bucket) => ok(bucketInfo(bucket)))],
    [
      "DELETE",
      "/r2/buckets/:name",
      withBucket((bucket) => {
        if (bucket.objects > 0)
          return fail(409, 10008, "The bucket you tried to delete is not empty.");
        state.r2.buckets.splice(state.r2.buckets.indexOf(bucket), 1);
        return ok({});
      }),
    ],
    ["GET", "/r2/buckets/:name/lifecycle", withBucket((bucket) => ok({ rules: bucket.lifecycle }))],
    [
      "PUT",
      "/r2/buckets/:name/lifecycle",
      withBucket(async (bucket, { request }) => {
        bucket.lifecycle = await rules<R2LifecycleRule>(request);
        return ok({});
      }),
    ],
    ["GET", "/r2/buckets/:name/lock", withBucket((bucket) => ok({ rules: bucket.lock }))],
    [
      "PUT",
      "/r2/buckets/:name/lock",
      withBucket(async (bucket, { request }) => {
        bucket.lock = await rules<R2LockRule>(request);
        return ok({});
      }),
    ],
  ];

  // Workers for Platforms: scripts in dispatch namespaces, which exist once named.

  const scriptInfo = (script: FakeScript) => ({
    id: script.name,
    etag: script.etag,
    tags: [...script.tags],
    migration_tag: script.migrationTag,
    created_on: script.createdOn,
    modified_on: script.modifiedOn,
  });
  const findScript = ({ params }: Call) =>
    state.dispatch.scripts.find(
      (item) => item.namespace === params.namespace && item.name === params.script,
    );
  const noScript = () => fail(404, 10007, "This Worker does not exist on your account.");

  const dispatchRoutes: Route[] = [
    // `tags=a:yes,b:no` keeps the scripts tagged `a` and not tagged `b`.
    [
      "GET",
      "/workers/dispatch/namespaces/:namespace/scripts",
      ({ params, url }) => {
        const filters = (url.searchParams.get("tags") ?? "")
          .split(",")
          .filter(Boolean)
          .map((filter) => {
            const [tag, wanted = "yes"] = filter.split(":");
            return { tag, wanted: wanted !== "no" };
          });
        const found = state.dispatch.scripts.filter(
          (script) =>
            script.namespace === params.namespace &&
            filters.every(({ tag, wanted }) => script.tags.includes(tag) === wanted),
        );
        return page(url, found.map(scriptInfo), 100);
      },
    ],
    // A missing script answers 200 with `script: null`, as the real API does.
    [
      "GET",
      "/workers/dispatch/namespaces/:namespace/scripts/:script",
      (call) => {
        const script = findScript(call);
        return ok({
          dispatch_namespace: call.params.namespace,
          created_on: script?.createdOn ?? null,
          modified_on: script?.modifiedOn ?? null,
          script: script ? scriptInfo(script) : null,
        });
      },
    ],
    ["PUT", "/workers/dispatch/namespaces/:namespace/scripts/:script", upload],
    [
      "DELETE",
      "/workers/dispatch/namespaces/:namespace/scripts/:script",
      (call) => {
        const script = findScript(call);
        if (!script) return noScript();
        state.dispatch.scripts.splice(state.dispatch.scripts.indexOf(script), 1);
        return ok(null);
      },
    ],
    [
      "PUT",
      "/workers/dispatch/namespaces/:namespace/scripts/:script/secrets",
      async (call) => {
        const script = findScript(call);
        if (!script) return noScript();
        const secret = await json<{ name?: string; text?: string; type?: string }>(call.request);
        if (secret.type !== "secret_text")
          return fail(400, 10021, `Unsupported secret type ${secret.type}`);
        if (!secret.name || typeof secret.text !== "string")
          return fail(400, 10021, "A secret needs a name and a text");
        script.secrets.set(secret.name, secret.text);
        script.modifiedOn = timestamp();
        return ok({ name: secret.name, type: secret.type });
      },
    ],
    [
      "PUT",
      "/workers/dispatch/namespaces/:namespace/scripts/:script/tags",
      async (call) => {
        const script = findScript(call);
        if (!script) return noScript();
        const tags = await json<string[]>(call.request);
        if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
          return fail(400, 10021, "Tags must be an array of strings");
        script.tags = [...tags];
        return ok([...tags]);
      },
    ],
  ];

  /**
   * A script upload: a `metadata` part and one part per module. It checks what Cloudflare checks
   * before it deploys: the main module was uploaded, each D1 binding names its database `id`, a
   * migration starts from the script's current tag and names classes that exist, and a Durable
   * Object binding of the script's own names a class it has.
   */
  async function upload(call: Call) {
    const form = await call.request.formData().catch(() => null);
    const part = form?.get("metadata");
    if (!form || !(part instanceof Blob))
      return fail(400, 10021, "The upload needs a multipart metadata part");
    let metadata: WorkerMetadata;
    try {
      metadata = JSON.parse(await part.text()) as WorkerMetadata;
    } catch {
      return fail(400, 10021, "The metadata part is not JSON");
    }
    const modules = new Map<string, FakeScriptModule>();
    for (const [name, value] of form.entries())
      if (name !== "metadata" && value instanceof Blob) {
        const bytes = new Uint8Array(await value.arrayBuffer());
        modules.set(name, { type: value.type, bytes, text: new TextDecoder().decode(bytes) });
      }
    if (!modules.has(metadata.main_module))
      return fail(
        400,
        10021,
        `No such module "${metadata.main_module}"; main_module must be uploaded`,
      );
    const bindings = (metadata.bindings ?? []) as unknown as Record<string, unknown>[];
    const d1WithoutId = bindings.find((binding) => binding.type === "d1" && !binding.id);
    if (d1WithoutId)
      return fail(400, 10021, `D1 binding ${String(d1WithoutId.name)} needs the database id`);

    const previous = findScript(call);
    const current = previous?.migrationTag ?? null;
    const classes = new Set(previous?.durableObjectClasses ?? []);
    const migrations = metadata.migrations as
      | (WorkerMetadata["migrations"] & Record<string, unknown>)
      | undefined;
    if (migrations) {
      if ((migrations.old_tag ?? null) !== current)
        return fail(
          400,
          10079,
          `Migration tag precondition failed; current tag is ${current === null ? "not set" : `"${current}"`}`,
        );
      if (!migrations.new_tag) return fail(400, 10021, "A migration needs a new_tag");
      // One migration may be sent flat or as `steps`.
      const steps = (migrations.steps ?? [migrations]) as Record<string, unknown>[];
      for (const step of steps) {
        const created = [
          ...((step.new_classes as string[] | undefined) ?? []),
          ...((step.new_sqlite_classes as string[] | undefined) ?? []),
        ];
        for (const name of created) {
          if (classes.has(name))
            return fail(400, 10021, `Cannot create class ${name}: it already exists`);
          classes.add(name);
        }
        for (const { from, to } of (step.renamed_classes as { from: string; to: string }[]) ?? []) {
          if (!classes.has(from) || classes.has(to))
            return fail(400, 10021, `Cannot rename class ${from} to ${to}`);
          classes.delete(from);
          classes.add(to);
        }
        for (const name of (step.deleted_classes as string[] | undefined) ?? []) {
          if (!classes.has(name))
            return fail(400, 10021, `Cannot delete class ${name}: it does not exist`);
          classes.delete(name);
        }
      }
    }
    const unbound = bindings.find(
      (binding) =>
        binding.type === "durable_object_namespace" &&
        !binding.script_name &&
        !classes.has(String(binding.class_name)),
    );
    if (unbound)
      return fail(
        400,
        10061,
        `Cannot create binding for class ${String(unbound.class_name)} because it is not currently configured to implement Durable Objects. Did you forget to apply a Durable Object migration?`,
      );

    const secrets = new Map(
      metadata.keep_bindings?.includes("secret_text") ? (previous?.secrets ?? []) : [],
    );
    for (const binding of bindings)
      if (binding.type === "secret_text") secrets.set(String(binding.name), String(binding.text));
    const script: FakeScript = {
      namespace: call.params.namespace,
      name: call.params.script,
      metadata,
      modules,
      migrationTag: migrations?.new_tag ?? current,
      durableObjectClasses: [...classes],
      tags: metadata.tags ?? previous?.tags ?? [],
      secrets,
      uploads: (previous?.uploads ?? 0) + 1,
      etag: await etag(modules),
      createdOn: previous?.createdOn ?? timestamp(),
      modifiedOn: timestamp(),
    };
    if (previous)
      state.dispatch.scripts.splice(state.dispatch.scripts.indexOf(previous), 1, script);
    else {
      state.dispatch.scripts.push(script);
      creates.scripts += 1;
    }
    return ok(scriptInfo(script));
  }

  const routes = [...d1Routes, ...kvRoutes, ...r2Routes, ...dispatchRoutes];

  function route(request: Request, url: URL, segments: string[]) {
    const header = request.headers.get("cf-r2-jurisdiction");
    const jurisdiction = (header ?? "default") as Jurisdiction | "default";
    for (const [method, pattern, handle] of routes) {
      if (method !== request.method) continue;
      const params = match(pattern, segments);
      if (params) return handle({ request, url, params, jurisdiction });
    }
    return fail(400, 7000, `No route for that URI: ${request.method} /${segments.join("/")}`);
  }

  async function answer(request: Request, url: URL, segments: string[]) {
    try {
      return await route(request, url, segments);
    } catch (error) {
      if (error instanceof BadRequest) return fail(400, error.code, error.message);
      throw error;
    }
  }

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === EXPORT_ORIGIN) {
      const [bookmark, filename] = url.pathname.slice(1).split("/");
      const done = exports.get(bookmark);
      if (!done || done.filename !== filename) return new Response("Not Found", { status: 404 });
      return new Response(done.sql, { headers: { "content-type": "application/sql" } });
    }
    if (url.origin !== API_ORIGIN)
      throw new TypeError(
        `The fake Cloudflare API got a request for ${url.origin}: ${request.url}`,
      );
    if (!url.pathname.startsWith(API_PREFIX)) return fail(400, 7000, "No route for that URI");
    const [account, ...rest] = url.pathname.slice(API_PREFIX.length).split("/");
    if (account !== accountId) return fail(403, 9109, "Unauthorized to access requested resource");
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer || (options.token !== undefined && bearer !== options.token))
      return fail(403, 10000, "Authentication error");

    const path = `/${rest.join("/")}`;
    calls.push(`${request.method} ${path}`);
    const segments = rest.map((segment) => decodeURIComponent(segment));
    const failure = failures.find((item) => {
      item.pattern.lastIndex = 0;
      return item.times > 0 && item.method === request.method && item.pattern.test(path);
    });
    if (!failure) return answer(request, url, segments);
    if (failure.skip > 0) {
      failure.skip -= 1;
      return answer(request, url, segments);
    }
    failure.times -= 1;
    if (failure.apply) await answer(request, url, segments);
    if (failure.network) throw new TypeError("fetch failed");
    return fail(failure.status, failure.code, failure.message);
  }) as typeof globalThis.fetch;

  return {
    accountId,
    /** A token the fake accepts: `options.token`, or a placeholder when any token goes. */
    token,
    fetch,
    state,
    creates,
    calls,
    /**
     * Fails the next call (or `times` calls) whose method matches and whose path under
     * `/accounts/<id>` matches `pattern`, such as `failNext("POST", /^\/d1\/database$/)`.
     * Each call is tested as a fresh copy of the pattern would test it, so a `g` or `y` flag
     * carries no `lastIndex` from one call to the next.
     */
    failNext(method: string, pattern: RegExp, failure: FakeFailure = {}) {
      failures.push({
        method: method.toUpperCase(),
        pattern: new RegExp(pattern),
        status: failure.status ?? 500,
        code: failure.code ?? 10000,
        message: failure.message ?? "Injected failure",
        network: failure.network ?? false,
        apply: failure.apply ?? false,
        times: failure.times ?? 1,
        skip: failure.skip ?? 0,
      });
    },
    /** Drops every failure `failNext` set up that has not happened yet. */
    clearFailures() {
      failures.length = 0;
    },
  };
}

/** The fake `createFakeCloudflareApi` returns. */
export type FakeCloudflareApi = ReturnType<typeof createFakeCloudflareApi>;

/** The route's parameters when the path's segments match the pattern's, `:name` taking any one. */
function match(pattern: string, segments: string[]) {
  const parts = pattern.slice(1).split("/");
  if (parts.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of parts.entries()) {
    if (part.startsWith(":")) params[part.slice(1)] = segments[index];
    else if (part !== segments[index]) return undefined;
  }
  return params;
}

/** A content hash of the modules, as Cloudflare's script etag is. */
async function etag(modules: Map<string, FakeScriptModule>) {
  const parts = [...modules].flatMap(([name, module]) => [
    new TextEncoder().encode(`${name}\0${module.type}\0`),
    module.bytes,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
