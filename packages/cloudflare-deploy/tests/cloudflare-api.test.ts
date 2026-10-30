import { expect, test } from "vitest";
import {
  CloudflareApiError,
  type CloudflareApiOptions,
  cloudflareApi,
} from "../src/cloudflare-api.js";

type Call = { method: string; url: URL; headers: Headers; body: unknown };

function fakeApi(
  handler: (call: Call) => { status?: number; body: unknown },
  options: Pick<CloudflareApiOptions, "retry"> = {},
) {
  const calls: Call[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body =
      raw instanceof FormData ? raw : typeof raw === "string" ? JSON.parse(raw) : undefined;
    const call = { method: init?.method ?? "GET", url: new URL(String(input)), headers, body };
    calls.push(call);
    const answer = handler(call);
    return Response.json(answer.body, { status: answer.status ?? 200 });
  }) as typeof fetch;
  const api = cloudflareApi({
    accountId: "a".repeat(32),
    token: "secret-token",
    fetch: transport,
    ...options,
  });
  return { api, calls };
}

const ok = (result: unknown, extra: object = {}) => ({
  body: { success: true, errors: [], result, ...extra },
});

test("sends the bearer token and checks both the status and the envelope", async () => {
  const { api, calls } = fakeApi(() => ok([{ uuid: "db-1", name: "app-a" }]));
  expect(await api.d1.find("app-a")).toEqual({ uuid: "db-1", name: "app-a" });
  expect(calls[0].url.pathname).toBe(`/client/v4/accounts/${"a".repeat(32)}/d1/database`);
  expect(calls[0].url.searchParams.get("name")).toBe("app-a");
  expect(calls[0].headers.get("authorization")).toBe("Bearer secret-token");

  const failing = fakeApi(() => ({
    status: 400,
    body: { success: false, errors: [{ code: 7400, message: "bad" }] },
  }));
  const error = await failing.api.d1.create({ name: "x" }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CloudflareApiError);
  expect((error as CloudflareApiError).has(7400)).toBe(true);
  // The message names the call and the codes, never the token.
  expect((error as Error).message).not.toContain("secret-token");
});

test("a D1 name search only matches the exact name", async () => {
  const { api } = fakeApi(() => ok([{ uuid: "db-2", name: "app-ab" }]));
  expect(await api.d1.find("app-a")).toBeUndefined();
});

test("a D1 name search pages through its matches to the exact name", async () => {
  // A hundred databases whose names contain the one wanted fill the first page.
  const similar = Array.from({ length: 100 }, (_, index) => ({
    uuid: `db-${index}`,
    name: `app-a-${index + 1}`,
  }));
  const { api, calls } = fakeApi(({ url }) =>
    url.searchParams.get("page") === "1"
      ? ok(similar, { result_info: { page: 1, total_pages: 2 } })
      : ok([{ uuid: "db-wanted", name: "app-a" }], { result_info: { page: 2, total_pages: 2 } }),
  );
  expect(await api.d1.find("app-a")).toEqual({ uuid: "db-wanted", name: "app-a" });
  expect(calls.map(({ url }) => url.searchParams.get("page"))).toEqual(["1", "2"]);
  expect(calls[1].url.searchParams.get("name")).toBe("app-a");
  expect(calls[1].url.searchParams.get("per_page")).toBe("100");
});

test("D1 create sends replication and drops the location hint under a jurisdiction", async () => {
  const { api, calls } = fakeApi(() => ok({ uuid: "db-1", name: "n" }));
  await api.d1.create({
    name: "n",
    jurisdiction: "eu",
    primaryLocationHint: "weur",
    readReplication: true,
  });
  await api.d1.create({ name: "m", primaryLocationHint: "enam" });
  expect(calls.map((call) => call.body)).toEqual([
    { name: "n", jurisdiction: "eu", read_replication: { mode: "auto" } },
    { name: "m", primary_location_hint: "enam" },
  ]);
});

test("a D1 export polls with its bookmark until the signed URL is ready", async () => {
  let polls = 0;
  const { api, calls } = fakeApi(() =>
    ++polls < 3
      ? ok({ at_bookmark: `b${polls}`, status: "active" })
      : ok({ status: "complete", result: { signed_url: "https://r2.test/x", filename: "x.sql" } }),
  );
  expect(await api.d1.export("db-1", { sleep: async () => {} })).toEqual({
    signedUrl: "https://r2.test/x",
    filename: "x.sql",
  });
  expect(
    calls.map((call) => (call.body as { current_bookmark?: string }).current_bookmark),
  ).toEqual([undefined, "b1", "b2"]);
});

test("KV lookups page through every namespace", async () => {
  const { api, calls } = fakeApi(({ url }) => {
    const page = Number(url.searchParams.get("page"));
    const items =
      page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ id: `kv-${i}`, title: `other-${i}` }))
        : [{ id: "kv-wanted", title: "app-a" }];
    return ok(items, { result_info: { page, per_page: 100, total_count: 101 } });
  });
  expect(await api.kv.find("app-a")).toEqual({ id: "kv-wanted", title: "app-a" });
  expect(calls).toHaveLength(2);
  expect(calls[0].url.searchParams.get("per_page")).toBe("100");
});

test("KV key listings follow the cursor, and bulk writes and deletes send one array", async () => {
  const { api, calls } = fakeApi(({ url }) =>
    url.pathname.endsWith("/keys")
      ? url.searchParams.get("cursor")
        ? ok([{ name: "assets/b.js" }], { result_info: { count: 1, cursor: "" } })
        : ok([{ name: "assets/a.js" }], { result_info: { count: 1, cursor: "next" } })
      : ok({ successful_key_count: 1, unsuccessful_keys: [] }),
  );
  expect(await api.kv.listKeys("ns", { prefix: "assets/" })).toEqual([
    "assets/a.js",
    "assets/b.js",
  ]);
  expect(calls.map((call) => call.url.searchParams.get("prefix"))).toEqual(["assets/", "assets/"]);
  expect(calls[1].url.searchParams.get("cursor")).toBe("next");

  await api.kv.putMany("ns", [{ key: "assets/a.js", value: "YQ==", base64: true }]);
  await api.kv.deleteMany("ns", ["assets/a.js"]);
  expect(calls.slice(2).map(({ method, url, body }) => [method, url.pathname, body])).toEqual([
    [
      "PUT",
      `/client/v4/accounts/${"a".repeat(32)}/storage/kv/namespaces/ns/bulk`,
      [{ key: "assets/a.js", value: "YQ==", base64: true }],
    ],
    [
      "POST",
      `/client/v4/accounts/${"a".repeat(32)}/storage/kv/namespaces/ns/bulk/delete`,
      ["assets/a.js"],
    ],
  ]);
});

const internalError = {
  status: 500,
  body: { success: false, errors: [{ code: 10000, message: "internal error" }] },
};

test("with retry, a request safe to repeat is sent again after a 429 or 5xx, pausing longer each time", async () => {
  const pauses: number[] = [];
  let failures = 2;
  const { api, calls } = fakeApi(
    ({ method }) =>
      method === "GET" && failures-- > 0
        ? internalError
        : ok([{ name: "assets/a.js" }], { result_info: { cursor: "" } }),
    { retry: { attempts: 3, delayMs: 10, sleep: async (ms) => void pauses.push(ms) } },
  );
  expect(await api.kv.listKeys("ns", { prefix: "assets/" })).toEqual(["assets/a.js"]);
  expect(calls).toHaveLength(3);
  expect(pauses).toEqual([10, 20]);

  // A bulk delete is a POST, but deleting the same keys twice changes nothing more.
  let deleteFailures = 1;
  const deletes = fakeApi(() => (deleteFailures-- > 0 ? internalError : ok({})), {
    retry: { attempts: 3, sleep: async () => {} },
  });
  await deletes.api.kv.deleteMany("ns", ["assets/a.js"]);
  expect(deletes.calls).toHaveLength(2);
});

test("with retry, the last failure throws, and a create or a 4xx is sent once", async () => {
  const failing = fakeApi(() => internalError, { retry: { attempts: 3, sleep: async () => {} } });
  const error = await failing.api.kv.listKeys("ns").catch((caught: unknown) => caught);
  expect((error as CloudflareApiError).status).toBe(500);
  expect(failing.calls).toHaveLength(3);

  // A create that failed may have created the namespace; sending it again could make a second.
  await failing.api.kv.create({ title: "t" }).catch(() => {});
  expect(failing.calls).toHaveLength(4);

  const refused = fakeApi(
    () => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: "auth" }] } }),
    { retry: { attempts: 3, sleep: async () => {} } },
  );
  await refused.api.kv.listKeys("ns").catch(() => {});
  expect(refused.calls).toHaveLength(1);
});

test("with retry, a request that fails on the way is sent again; without it, it throws at once", async () => {
  let calls = 0;
  const transport = (async () => {
    if (++calls === 1) throw new TypeError("fetch failed");
    return new Response("value");
  }) as typeof fetch;
  const api = cloudflareApi({
    accountId: "a".repeat(32),
    token: "t",
    fetch: transport,
    retry: { attempts: 2, sleep: async () => {} },
  });
  expect(await api.kv.getText("ns", "record")).toBe("value");
  expect(calls).toBe(2);

  const once = fakeApi(() => internalError);
  await once.api.kv.listKeys("ns").catch(() => {});
  expect(once.calls).toHaveLength(1);
});

test("a KV value comes back raw, and a missing key is undefined", async () => {
  const paths: string[] = [];
  const transport = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith("/values/record")) return new Response('{"build":"b"}');
    if (url.pathname.endsWith("/values/broken"))
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "auth" }] },
        {
          status: 403,
        },
      );
    return Response.json(
      { success: false, errors: [{ code: 10009, message: "key not found" }] },
      { status: 404 },
    );
  }) as typeof fetch;
  const api = cloudflareApi({ accountId: "a".repeat(32), token: "t", fetch: transport });
  expect(await api.kv.getText("ns", "record")).toBe('{"build":"b"}');
  expect(await api.kv.getText("ns", "assets/missing.js")).toBeUndefined();
  const error = await api.kv.getText("ns", "broken").catch((caught: unknown) => caught);
  expect((error as CloudflareApiError).has(10000)).toBe(true);
  // A key's slash is part of the key, not of the path.
  expect(paths[1]).toMatch(/\/values\/assets%2Fmissing\.js$/);
});

test("R2 calls carry the jurisdiction header and a missing bucket is undefined", async () => {
  const { api, calls } = fakeApi(({ method }) =>
    method === "GET"
      ? {
          status: 404,
          body: { success: false, errors: [{ code: 10006, message: "NoSuchBucket" }] },
        }
      : ok({ name: "app-a" }),
  );
  expect(await api.r2.get("app-a", "eu")).toBeUndefined();
  await api.r2.create({ name: "app-a", jurisdiction: "eu", locationHint: "weur" });
  await api.r2.create({ name: "app-b", locationHint: "enam" });
  expect(calls.map((call) => call.headers.get("cf-r2-jurisdiction"))).toEqual(["eu", "eu", null]);
  // The jurisdiction places a bucket; the hint applies only without one.
  expect(calls[1].body).toEqual({ name: "app-a" });
  expect(calls[2].body).toEqual({ name: "app-b", locationHint: "enam" });
});

test("a namespace script answered with script null or 404 is undefined", async () => {
  const { api } = fakeApi(({ url }) =>
    url.pathname.endsWith("/customer-null")
      ? ok({ dispatch_namespace: "customers-production", script: null })
      : url.pathname.endsWith("/customer-gone")
        ? { status: 404, body: { success: false, errors: [{ code: 10007, message: "missing" }] } }
        : ok({
            dispatch_namespace: "customers-production",
            script: { id: "customer-a", migration_tag: "v2" },
          }),
  );
  expect(await api.dispatch.getScript("customers-production", "customer-null")).toBeUndefined();
  expect(await api.dispatch.getScript("customers-production", "customer-gone")).toBeUndefined();
  expect(await api.dispatch.getScript("customers-production", "customer-a")).toEqual({
    script: { id: "customer-a", migration_tag: "v2" },
  });
});

test("a namespace script upload is multipart with metadata and one part per module", async () => {
  const { api, calls } = fakeApi(() => ok({ id: "customer-a", migration_tag: "v1" }));
  await api.dispatch.uploadScript("customers-preview", "customer-a", {
    metadata: {
      main_module: "worker.js",
      compatibility_date: "2026-09-29",
      bindings: [{ type: "d1", name: "APP_DB", id: "db-1" }],
      keep_bindings: ["secret_text"],
      tags: ["customer:a"],
      migrations: { new_tag: "v1", steps: [{ new_sqlite_classes: ["RealtimeHub"] }] },
    },
    modules: [
      { name: "worker.js", content: "export default {}", type: "application/javascript+module" },
      { name: "index.js", content: "export {}", type: "application/javascript+module" },
    ],
  });
  const call = calls[0];
  expect(call.method).toBe("PUT");
  expect(call.url.pathname).toMatch(
    /\/workers\/dispatch\/namespaces\/customers-preview\/scripts\/customer-a$/,
  );
  const form = call.body as FormData;
  const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
  expect(metadata.main_module).toBe("worker.js");
  expect(metadata.bindings).toEqual([{ type: "d1", name: "APP_DB", id: "db-1" }]);
  const main = form.get("worker.js") as File;
  expect(main.type).toBe("application/javascript+module");
  expect(await main.text()).toBe("export default {}");
});

test("deletes answer false for a resource that is already gone and pass force", async () => {
  const { api, calls } = fakeApi(({ method, url }) =>
    url.pathname.endsWith("/scripts/customer-a") && method === "DELETE"
      ? ok(null)
      : { status: 404, body: { success: false, errors: [{ code: 10007, message: "gone" }] } },
  );
  expect(await api.dispatch.deleteScript("ns", "customer-a", { force: true })).toBe(true);
  expect(calls[0].url.searchParams.get("force")).toBe("true");
  expect(await api.d1.delete("db-1")).toBe(false);
  expect(await api.kv.delete("kv-1")).toBe(false);
  expect(await api.r2.delete("app-a")).toBe(false);
});
