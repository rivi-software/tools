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
import type {
  Jurisdiction,
  LocationHint,
  R2LifecycleRule,
  R2LockRule,
  WorkerMetadata,
} from "./cloudflare-api.js";
import { CLOUDFLARE_API } from "./cloudflare-api.js";
import { compareKeys, decodeCursor, encodeCursor } from "./memory-kv.js";

export interface FakeD1Database {
  uuid: string;
  name: string;
  jurisdiction: Jurisdiction | null;
  primaryLocationHint: LocationHint | null;
  readReplication: { mode: string };
  createdAt: string;
  /** The SQL an export of the database serves. Set it to give a test's export some content. */
  sql: string;
}

/** A stored KV value, as the bulk write sent it: text, or base64 with `base64: true`. */
export interface FakeKvValue {
  value: string;
  base64: boolean;
  metadata?: unknown;
}

export interface FakeKvNamespace {
  id: string;
  title: string;
  jurisdiction: Jurisdiction | null;
  values: Map<string, FakeKvValue>;
}

export interface FakeR2Bucket {
  name: string;
  /** `default` for a bucket created without the `cf-r2-jurisdiction` header. */
  jurisdiction: Jurisdiction | "default";
  location: LocationHint | null;
  createdAt: string;
  lifecycle: R2LifecycleRule[];
  lock: R2LockRule[];
  /** How many objects the bucket holds. A bucket that holds any cannot be deleted (409, 10008). */
  objects: number;
}

export interface FakeScriptModule {
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
  text: string;
}

export interface FakeScript {
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
}

export interface FakeCloudflareApiOptions {
  /** The account the fake serves. Default 32 `f`s. Calls to another account answer 403 (9109). */
  accountId?: string;
  /**
   * The only token the fake accepts. Any other answers 403 (10000). By default it accepts any
   * bearer token.
   */
  token?: string;
  /** The clock for creation and modification times, in milliseconds. Default `Date.now`. */
  now?: () => number;
}

export interface FakeFailure {
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
}

type Failure = Required<Omit<FakeFailure, "message">> & {
  method: string;
  pattern: RegExp;
  message: string;
};

interface Call {
  request: Request;
  url: URL;
  params: Record<string, string>;
  /** The R2 jurisdiction the `cf-r2-jurisdiction` header names, or `default`. */
  jurisdiction: Jurisdiction | "default";
}

type Route = [
  method: string,
  pattern: string,
  handle: (call: Call) => Promise<Response> | Response,
];

/** A malformed request body: answered 400 with this code and message. */
class BadRequestError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "BadRequestError";
    this.code = code;
  }
}

const API_ORIGIN = new URL(CLOUDFLARE_API).origin;
const API_PREFIX = `${new URL(CLOUDFLARE_API).pathname}/accounts/`;

/** Where finished D1 exports are served. `.test` is reserved, so nothing real answers there. */
const EXPORT_ORIGIN = "https://d1-exports.fake-cloudflare.test";
const R2_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;

/** The envelope's `result_info`, for a paged or cursored answer. */
interface ResultInfo {
  page?: number;
  per_page?: number;
  count?: number;
  total_count?: number;
  cursor?: string;
}

/** What the fake holds: every resource the account has. */
interface FakeState {
  d1: { databases: FakeD1Database[] };
  kv: { namespaces: FakeKvNamespace[] };
  r2: { buckets: FakeR2Bucket[] };
  dispatch: { scripts: FakeScript[] };
}

/** The summary of a bucket a listing or lookup answers. */
interface R2BucketSummary {
  name: string;
  creation_date: string;
  location?: string;
  jurisdiction?: Jurisdiction;
  storage_class: string;
}

/** A binding of an upload's metadata, read field by field rather than through its union. */
interface UploadBinding {
  type?: string;
  name?: unknown;
  id?: unknown;
  text?: unknown;
  script_name?: unknown;
  class_name?: unknown;
}

interface UploadMigrationStep {
  new_classes?: string[];
  new_sqlite_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
  deleted_classes?: string[];
}

/** An upload's `migrations`, which a test may send flat or as `steps`. */
interface UploadMigrations extends UploadMigrationStep {
  old_tag?: string | null;
  new_tag?: string;
  steps?: UploadMigrationStep[];
}

const isString = (value: unknown): value is string => typeof value === "string";

const ok = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the fake answers whatever JSON the endpoint documents
  result: unknown,
  extra: { result_info?: ResultInfo } = {}
) =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...extra,
  });

const fail = (status: number, code: number, message: string) =>
  Response.json(
    {
      success: false,
      errors: [{ code, message }],
      messages: [],
      result: null,
    },
    { status }
  );

const json = async <T>(request: Request): Promise<T> => {
  try {
    // SAFETY: the caller names the body its endpoint documents, and reads every field as optional
    return (await request.json()) as T;
  } catch {
    throw new BadRequestError(6007, "Malformed JSON in request body");
  }
};

const page = <T>(url: URL, items: T[], fallback: number) => {
  const number = Math.max(
    1,
    Math.floor(Number(url.searchParams.get("page") ?? 1)) || 1
  );

  const perPage = Math.max(
    1,
    Math.floor(Number(url.searchParams.get("per_page") ?? fallback)) || fallback
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
};

/** The route's parameters when the path's segments match the pattern's, `:name` taking any one. */
const match = (pattern: string, segments: string[]) => {
  const parts = pattern.slice(1).split("/");

  if (parts.length !== segments.length) {
    return;
  }

  const params: Record<string, string> = {};

  for (const [index, part] of parts.entries()) {
    if (part.startsWith(":")) {
      params[part.slice(1)] = segments[index];
    } else if (part !== segments[index]) {
      return;
    }
  }

  return params;
};

/** A content hash of the modules, as Cloudflare's script etag is. */
const etag = async (modules: Map<string, FakeScriptModule>) => {
  const parts = [...modules].flatMap(([name, module]) => [
    new TextEncoder().encode(`${name}\0${module.type}\0`),
    module.bytes,
  ]);

  const digest = await crypto.subtle.digest(
    "SHA-256",
    await new Blob(parts).arrayBuffer()
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const databaseInfo = (database: FakeD1Database) => ({
  uuid: database.uuid,
  name: database.name,
  version: "production",
  created_at: database.createdAt,
  jurisdiction: database.jurisdiction,
  read_replication: { ...database.readReplication },
});

const noDatabase = (id: string) =>
  fail(404, 7404, `The database ${id} could not be found`);

const namespaceInfo = (namespace: FakeKvNamespace) => ({
  id: namespace.id,
  title: namespace.title,
  supports_url_encoding: true,
});

const noNamespace = () => fail(404, 10_013, "namespace not found");

const bucketInfo = (bucket: FakeR2Bucket) => {
  const info: R2BucketSummary = {
    name: bucket.name,
    creation_date: bucket.createdAt,
    storage_class: "Standard",
  };

  if (bucket.location) {
    info.location = bucket.location.toUpperCase();
  }

  if (bucket.jurisdiction !== "default") {
    info.jurisdiction = bucket.jurisdiction;
  }

  return info;
};

const noBucket = () =>
  fail(404, 10_006, "The specified bucket does not exist.");

const rules = async <T>(request: Request) => {
  const body = await json<{ rules?: T[] }>(request);

  if (!Array.isArray(body.rules)) {
    throw new BadRequestError(10_040, "rules must be an array");
  }

  return body.rules;
};

const scriptInfo = (script: FakeScript) => ({
  id: script.name,
  etag: script.etag,
  tags: [...script.tags],
  migration_tag: script.migrationTag,
  created_on: script.createdOn,
  modified_on: script.modifiedOn,
});

const noScript = () =>
  fail(404, 10_007, "This Worker does not exist on your account.");

/**
 * The script's secrets after an upload: those of the previous script when `keep_bindings` keeps
 * them, plus every `secret_text` binding the upload carries.
 */
const uploadSecrets = (
  bindings: UploadBinding[],
  metadata: WorkerMetadata,
  previous: FakeScript | undefined
) => {
  const keep = metadata.keep_bindings?.includes("secret_text");
  const secrets = new Map(keep ? previous?.secrets : undefined);

  for (const binding of bindings) {
    if (binding.type === "secret_text") {
      secrets.set(String(binding.name), String(binding.text));
    }
  }

  return secrets;
};

/** Everything an upload settles about the script it stores. */
interface ScriptUpload {
  call: Call;
  previous: FakeScript | undefined;
  metadata: WorkerMetadata;
  modules: Map<string, FakeScriptModule>;
  migrationTag: string | null;
  classes: Set<string>;
  secrets: Map<string, string>;
  at: string;
}

/** The script an upload leaves behind, carrying forward what the previous one kept. */
const uploadedScript = async (input: ScriptUpload): Promise<FakeScript> => ({
  namespace: input.call.params.namespace,
  name: input.call.params.script,
  metadata: input.metadata,
  modules: input.modules,
  migrationTag: input.migrationTag,
  durableObjectClasses: [...input.classes],
  tags: input.metadata.tags ?? input.previous?.tags ?? [],
  secrets: input.secrets,
  uploads: (input.previous?.uploads ?? 0) + 1,
  etag: await etag(input.modules),
  createdOn: input.previous?.createdOn ?? input.at,
  modifiedOn: input.at,
});

/** The upload's module parts, by name; the `metadata` part is left out. */
const readUploadModules = async (form: FormData) => {
  const modules = new Map<string, FakeScriptModule>();

  for (const [name, value] of form.entries()) {
    if (name !== "metadata" && value instanceof Blob) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the parts are read in the order the form holds them
      const bytes = new Uint8Array(await value.arrayBuffer());
      modules.set(name, {
        type: value.type,
        bytes,
        text: new TextDecoder().decode(bytes),
      });
    }
  }

  return modules;
};

/** Cloudflare refuses a D1 binding without a database id; this answers that refusal, or null. */
const refuseD1WithoutId = (bindings: UploadBinding[]) => {
  const found = bindings.find(
    (binding) => binding.type === "d1" && !binding.id
  );

  return found
    ? fail(
        400,
        10_021,
        `D1 binding ${String(found.name)} needs the database id`
      )
    : null;
};

/** A Durable Object binding of the script's own must name a class it has after its migrations. */
const refuseUnboundDurableObject = (
  bindings: UploadBinding[],
  classes: Set<string>
) => {
  const found = bindings.find(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      !binding.script_name &&
      !classes.has(String(binding.class_name))
  );

  return found
    ? fail(
        400,
        10_061,
        `Cannot create binding for class ${String(found.class_name)} because it is not currently configured to implement Durable Objects. Did you forget to apply a Durable Object migration?`
      )
    : null;
};

/**
 * Replays an upload's migrations over the script's Durable Object classes, as Cloudflare does:
 * the tag must follow the script's current one, and each step must name classes that fit. Answers
 * the refusal, or `null` when the migrations apply.
 */
const applyMigrations = (
  migrations: UploadMigrations,
  classes: Set<string>,
  current: string | null
) => {
  if ((migrations.old_tag ?? null) !== current) {
    return fail(
      400,
      10_079,
      `Migration tag precondition failed; current tag is ${current === null ? "not set" : `"${current}"`}`
    );
  }

  if (!migrations.new_tag) {
    return fail(400, 10_021, "A migration needs a new_tag");
  }

  // One migration may be sent flat or as `steps`.
  const steps: UploadMigrationStep[] = migrations.steps ?? [migrations];

  for (const step of steps) {
    const created = [
      ...(step.new_classes ?? []),
      ...(step.new_sqlite_classes ?? []),
    ];

    for (const name of created) {
      if (classes.has(name)) {
        return fail(
          400,
          10_021,
          `Cannot create class ${name}: it already exists`
        );
      }

      classes.add(name);
    }

    for (const { from, to } of step.renamed_classes ?? []) {
      if (!classes.has(from) || classes.has(to)) {
        return fail(400, 10_021, `Cannot rename class ${from} to ${to}`);
      }

      classes.delete(from);
      classes.add(to);
    }

    for (const name of step.deleted_classes ?? []) {
      if (!classes.has(name)) {
        return fail(
          400,
          10_021,
          `Cannot delete class ${name}: it does not exist`
        );
      }

      classes.delete(name);
    }
  }

  return null;
};

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
export const createFakeCloudflareApi = (
  options: FakeCloudflareApiOptions = {}
) => {
  const accountId = options.accountId ?? "f".repeat(32);
  const token = options.token ?? "fake-cloudflare-token";
  const now = options.now ?? (() => Date.now());
  const timestamp = () => new Date(now()).toISOString();

  const state: FakeState = {
    d1: { databases: [] },
    kv: { namespaces: [] },
    r2: { buckets: [] },
    dispatch: { scripts: [] },
  };

  /** Successful creates of each kind; a script counts once, at its first upload. */
  const creates = { d1: 0, kv: 0, r2: 0, scripts: 0 };
  /** Each call that reached the account, as `METHOD /path` under `/accounts/<id>`. */
  const calls: string[] = [];
  const failures: Failure[] = [];
  const exports = new Map<string, { filename: string; sql: string }>();
  let sequence = 0;

  const nextSequence = () => {
    sequence += 1;

    return sequence;
  };

  const uuid = () =>
    `00000000-0000-4000-8000-${nextSequence().toString(16).padStart(12, "0")}`;

  const hexId = () => nextSequence().toString(16).padStart(32, "0");

  // D1

  const findDatabase = (id: string) =>
    state.d1.databases.find((item) => item.uuid === id);

  const d1Routes: Route[] = [
    // The name filter is a search: `app` also finds `app-2`.
    [
      "GET",
      "/d1/database",
      ({ url }) => {
        const name = url.searchParams.get("name") ?? "";

        const found = state.d1.databases.filter((item) =>
          item.name.includes(name)
        );

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

        if (!body.name) {
          return fail(400, 7400, "The request is malformed: name is required");
        }

        if (state.d1.databases.some((item) => item.name === body.name)) {
          return fail(400, 7502, "A database with that name already exists");
        }

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

        if (!database) {
          return noDatabase(params.id);
        }

        const body = await json<{ read_replication?: { mode?: string } }>(
          request
        );

        const mode = body.read_replication?.mode;

        if (mode !== undefined && mode !== "auto" && mode !== "disabled") {
          return fail(
            400,
            7400,
            `The request is malformed: unknown read_replication mode ${mode}`
          );
        }

        if (mode) {
          database.readReplication = { mode };
        }

        return ok(databaseInfo(database));
      },
    ],
    [
      "DELETE",
      "/d1/database/:id",
      ({ params }) => {
        const database = findDatabase(params.id);

        if (!database) {
          return noDatabase(params.id);
        }

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

        if (!database) {
          return noDatabase(params.id);
        }

        const body = await json<{
          output_format?: string;
          current_bookmark?: string;
        }>(request);

        if (body.output_format !== "polling") {
          return fail(
            400,
            7400,
            "The request is malformed: output_format must be polling"
          );
        }

        const started =
          body.current_bookmark && exports.get(body.current_bookmark);

        if (!started) {
          const bookmark = `bookmark-${nextSequence()}`;
          exports.set(bookmark, {
            filename: `${database.uuid}-${bookmark}.sql`,
            sql: database.sql,
          });

          return ok({
            type: "export",
            at_bookmark: bookmark,
            status: "active",
            messages: [],
          });
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

  const findNamespace = (id: string) =>
    state.kv.namespaces.find((item) => item.id === id);

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
        const body = await json<{
          title?: string;
          jurisdiction?: Jurisdiction;
        }>(request);

        if (!body.title) {
          return fail(400, 10_019, "title is required");
        }

        if (state.kv.namespaces.some((item) => item.title === body.title)) {
          return fail(
            400,
            10_014,
            "A namespace with this account ID and title already exists."
          );
        }

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

        if (!namespace) {
          return noNamespace();
        }

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

        if (!namespace) {
          return noNamespace();
        }

        const prefix = url.searchParams.get("prefix") ?? "";

        const limit = Math.min(
          1000,
          Math.max(10, Number(url.searchParams.get("limit")) || 1000)
        );

        const cursor = url.searchParams.get("cursor");
        let after: string | undefined;

        try {
          after = cursor ? decodeCursor(cursor) : undefined;
        } catch {
          return fail(400, 10_032, "Invalid cursor");
        }

        const names = [...namespace.values.keys()]
          .filter((name) => name.startsWith(prefix))
          .filter((name) => after === undefined || compareKeys(name, after) > 0)
          .toSorted(compareKeys);

        const keys = names.slice(0, limit).map((name) => {
          const metadata = namespace.values.get(name)?.metadata;

          return metadata === undefined ? { name } : { name, metadata };
        });

        const more = names.length > limit;
        const last = keys.at(-1);

        return ok(keys, {
          result_info: {
            count: keys.length,
            cursor: more && last ? encodeCursor(last.name) : "",
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

        if (!namespace) {
          return noNamespace();
        }

        const stored = namespace.values.get(params.key);

        if (!stored) {
          return fail(404, 10_009, "get: 'key not found'");
        }

        const bytes = stored.base64
          ? Uint8Array.from(
              atob(stored.value),
              (char) => char.codePointAt(0) ?? 0
            )
          : new TextEncoder().encode(stored.value);

        return new Response(bytes, {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    ],
    [
      "PUT",
      "/storage/kv/namespaces/:id/bulk",
      async ({ params, request }) => {
        const namespace = findNamespace(params.id);

        if (!namespace) {
          return noNamespace();
        }

        const entries = await json<
          {
            key: string;
            value: string;
            base64?: boolean;
            metadata?: unknown;
          }[]
        >(request);

        if (!Array.isArray(entries) || entries.length > 10_000) {
          return fail(
            400,
            10_026,
            "The body must be an array of up to 10,000 key-value pairs"
          );
        }

        for (const entry of entries) {
          if (!isString(entry?.key) || !isString(entry.value)) {
            return fail(
              400,
              10_026,
              "Each pair needs a string key and a string value"
            );
          }

          const stored: FakeKvValue = {
            value: entry.value,
            base64: entry.base64 === true,
          };

          if (entry.metadata !== undefined) {
            stored.metadata = entry.metadata;
          }

          namespace.values.set(entry.key, stored);
        }

        return ok({
          successful_key_count: entries.length,
          unsuccessful_keys: [],
        });
      },
    ],
    [
      "POST",
      "/storage/kv/namespaces/:id/bulk/delete",
      async ({ params, request }) => {
        const namespace = findNamespace(params.id);

        if (!namespace) {
          return noNamespace();
        }

        const keys = await json<string[]>(request);

        if (!Array.isArray(keys) || keys.length > 10_000) {
          return fail(
            400,
            10_026,
            "The body must be an array of up to 10,000 keys"
          );
        }

        for (const key of keys) {
          namespace.values.delete(key);
        }

        return ok({ successful_key_count: keys.length, unsuccessful_keys: [] });
      },
    ],
  ];

  // R2: a bucket is only found under the jurisdiction it was created in.

  const findBucket = ({ params, jurisdiction }: Call) =>
    state.r2.buckets.find(
      (item) => item.name === params.name && item.jurisdiction === jurisdiction
    );

  const withBucket =
    (
      handle: (bucket: FakeR2Bucket, call: Call) => Promise<Response> | Response
    ) =>
    (call: Call) => {
      const bucket = findBucket(call);

      return bucket ? handle(bucket, call) : noBucket();
    };

  const r2Routes: Route[] = [
    [
      "POST",
      "/r2/buckets",
      async (call) => {
        const body = await json<{ name?: string; locationHint?: LocationHint }>(
          call.request
        );

        if (!body.name || !R2_BUCKET_NAME.test(body.name)) {
          return fail(400, 10_005, "The specified bucket name is not valid.");
        }

        if (findBucket({ ...call, params: { name: body.name } })) {
          return fail(
            409,
            10_073,
            "The bucket you tried to create already exists, and you own it."
          );
        }

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
    [
      "GET",
      "/r2/buckets/:name",
      withBucket((bucket) => ok(bucketInfo(bucket))),
    ],
    [
      "DELETE",
      "/r2/buckets/:name",
      withBucket((bucket) => {
        if (bucket.objects > 0) {
          return fail(
            409,
            10_008,
            "The bucket you tried to delete is not empty."
          );
        }

        state.r2.buckets.splice(state.r2.buckets.indexOf(bucket), 1);

        return ok({});
      }),
    ],
    [
      "GET",
      "/r2/buckets/:name/lifecycle",
      withBucket((bucket) => ok({ rules: bucket.lifecycle })),
    ],
    [
      "PUT",
      "/r2/buckets/:name/lifecycle",
      withBucket(async (bucket, { request }) => {
        bucket.lifecycle = await rules<R2LifecycleRule>(request);

        return ok({});
      }),
    ],
    [
      "GET",
      "/r2/buckets/:name/lock",
      withBucket((bucket) => ok({ rules: bucket.lock })),
    ],
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

  const findScript = ({ params }: Call) =>
    state.dispatch.scripts.find(
      (item) =>
        item.namespace === params.namespace && item.name === params.script
    );

  /** Puts the uploaded script in place of the one it replaces, or stores it as a new script. */
  const storeScript = (
    previous: FakeScript | undefined,
    script: FakeScript
  ) => {
    if (previous) {
      state.dispatch.scripts.splice(
        state.dispatch.scripts.indexOf(previous),
        1,
        script
      );

      return;
    }

    state.dispatch.scripts.push(script);
    creates.scripts += 1;
  };

  /**
   * A script upload: a `metadata` part and one part per module. It checks what Cloudflare checks
   * before it deploys: the main module was uploaded, each D1 binding names its database `id`, a
   * migration starts from the script's current tag and names classes that exist, and a Durable
   * Object binding of the script's own names a class it has.
   */
  const upload = async (call: Call) => {
    const form = await call.request.formData().catch(() => null);
    const part = form?.get("metadata");

    if (!form || !(part instanceof Blob)) {
      return fail(400, 10_021, "The upload needs a multipart metadata part");
    }

    let metadata: WorkerMetadata;

    try {
      // SAFETY: the upload is a test's own metadata, and every field below is read as optional
      metadata = JSON.parse(await part.text()) as WorkerMetadata;
    } catch {
      return fail(400, 10_021, "The metadata part is not JSON");
    }

    const modules = await readUploadModules(form);

    if (!modules.has(metadata.main_module)) {
      return fail(
        400,
        10_021,
        `No such module "${metadata.main_module}"; main_module must be uploaded`
      );
    }

    // SAFETY: the fake reads a binding by its fields, which WorkerBinding's union all carry
    const bindings = (metadata.bindings ?? []) as UploadBinding[];
    const refusedD1 = refuseD1WithoutId(bindings);

    if (refusedD1) {
      return refusedD1;
    }

    const previous = findScript(call);
    const current = previous?.migrationTag ?? null;
    const classes = new Set(previous?.durableObjectClasses);
    // SAFETY: a test may send one migration flat, which WorkerMetadata's `steps` shape leaves out
    const migrations = metadata.migrations as UploadMigrations | undefined;

    const refusedMigration = migrations
      ? applyMigrations(migrations, classes, current)
      : null;

    if (refusedMigration) {
      return refusedMigration;
    }

    const refusedBinding = refuseUnboundDurableObject(bindings, classes);

    if (refusedBinding) {
      return refusedBinding;
    }

    const script = await uploadedScript({
      call,
      previous,
      metadata,
      modules,
      migrationTag: migrations?.new_tag ?? current,
      classes,
      secrets: uploadSecrets(bindings, metadata, previous),
      at: timestamp(),
    });

    storeScript(previous, script);

    return ok(scriptInfo(script));
  };

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
            filters.every(
              ({ tag, wanted }) => script.tags.includes(tag) === wanted
            )
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

        if (!script) {
          return noScript();
        }

        state.dispatch.scripts.splice(
          state.dispatch.scripts.indexOf(script),
          1
        );

        return ok(null);
      },
    ],
    [
      "PUT",
      "/workers/dispatch/namespaces/:namespace/scripts/:script/secrets",
      async (call) => {
        const script = findScript(call);

        if (!script) {
          return noScript();
        }

        const secret = await json<{
          name?: string;
          text?: string;
          type?: string;
        }>(call.request);

        if (secret.type !== "secret_text") {
          return fail(400, 10_021, `Unsupported secret type ${secret.type}`);
        }

        if (!secret.name || !isString(secret.text)) {
          return fail(400, 10_021, "A secret needs a name and a text");
        }

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

        if (!script) {
          return noScript();
        }

        const tags = await json<string[]>(call.request);

        if (!Array.isArray(tags) || tags.some((tag) => !isString(tag))) {
          return fail(400, 10_021, "Tags must be an array of strings");
        }

        script.tags = [...tags];

        return ok([...tags]);
      },
    ],
  ];

  const routes = [...d1Routes, ...kvRoutes, ...r2Routes, ...dispatchRoutes];

  const route = (request: Request, url: URL, segments: string[]) => {
    const header = request.headers.get("cf-r2-jurisdiction");
    // SAFETY: the header is only compared with a bucket's own jurisdiction, never trusted further
    const jurisdiction = (header ?? "default") as Jurisdiction | "default";

    for (const [method, pattern, handle] of routes) {
      if (method !== request.method) {
        continue;
      }

      const params = match(pattern, segments);

      if (params) {
        return handle({ request, url, params, jurisdiction });
      }
    }

    return fail(
      400,
      7000,
      `No route for that URI: ${request.method} /${segments.join("/")}`
    );
  };

  const answer = async (request: Request, url: URL, segments: string[]) => {
    try {
      return await route(request, url, segments);
    } catch (error) {
      if (error instanceof BadRequestError) {
        return fail(400, error.code, error.message);
      }

      throw error;
    }
  };

  /** The SQL of a finished export, served from its signed URL. */
  const downloadExport = (url: URL) => {
    const [bookmark, filename] = url.pathname.slice(1).split("/");
    const done = exports.get(bookmark);

    if (!done || done.filename !== filename) {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(done.sql, {
      headers: { "content-type": "application/sql" },
    });
  };

  /** The call's answer, or the failure `failNext` set up for it. */
  const answerOrFail = async (
    request: Request,
    url: URL,
    segments: string[],
    path: string
  ) => {
    const failure = failures.find((item) => {
      item.pattern.lastIndex = 0;

      return (
        item.times > 0 &&
        item.method === request.method &&
        item.pattern.test(path)
      );
    });

    if (!failure) {
      return answer(request, url, segments);
    }

    if (failure.skip > 0) {
      failure.skip -= 1;

      return answer(request, url, segments);
    }

    failure.times -= 1;

    if (failure.apply) {
      await answer(request, url, segments);
    }

    if (failure.network) {
      throw new TypeError("fetch failed");
    }

    return fail(failure.status, failure.code, failure.message);
  };

  // SAFETY: the fake answers every call the client makes, which it builds as a Request itself
  const fetch =
    // oxlint-disable-next-line eslint/require-await -- fetch must answer a promise even when the fake answers without awaiting anything
    (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.origin === EXPORT_ORIGIN) {
        return downloadExport(url);
      }

      if (url.origin !== API_ORIGIN) {
        throw new TypeError(
          `The fake Cloudflare API got a request for ${url.origin}: ${request.url}`
        );
      }

      if (!url.pathname.startsWith(API_PREFIX)) {
        return fail(400, 7000, "No route for that URI");
      }

      const [account, ...rest] = url.pathname
        .slice(API_PREFIX.length)
        .split("/");

      if (account !== accountId) {
        return fail(403, 9109, "Unauthorized to access requested resource");
      }

      const bearer = /^Bearer (?<token>.+)$/u.exec(
        request.headers.get("authorization") ?? ""
      )?.groups?.token;

      if (
        !bearer ||
        (options.token !== undefined && bearer !== options.token)
      ) {
        return fail(403, 10_000, "Authentication error");
      }

      const path = `/${rest.join("/")}`;
      calls.push(`${request.method} ${path}`);
      const segments = rest.map((segment) => decodeURIComponent(segment));

      return answerOrFail(request, url, segments, path);
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
        // oxlint-disable-next-line eslint/require-unicode-regexp -- this copies the caller's pattern, whose own flags decide how it matches
        pattern: new RegExp(pattern),
        status: failure.status ?? 500,
        code: failure.code ?? 10_000,
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
};

/** The fake `createFakeCloudflareApi` returns. */
export type FakeCloudflareApi = ReturnType<typeof createFakeCloudflareApi>;
