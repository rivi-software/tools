import { expect, test } from "vitest";
import { CloudflareApiError, cloudflareApi } from "../src/cloudflare-api.js";
import { createFakeCloudflareApi } from "../src/fake-cloudflare-api.js";

const noWait = { sleep: async () => {} };

/** The error a call rejects with. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error as CloudflareApiError,
  );

const worker = (main = "index.js") => ({
  name: main,
  content: "export default { fetch() { return new Response('ok') } }",
  type: "application/javascript+module",
});

test("the client works against the fake passed as its options", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  const database = await api.d1.create({ name: "app" });
  expect(database).toMatchObject({ name: "app", read_replication: { mode: "disabled" } });
  expect(fake.state.d1.databases.map((item) => item.name)).toEqual(["app"]);
  expect(fake.calls).toEqual(["POST /d1/database"]);
  expect(fake.creates.d1).toBe(1);
});

test("D1: names are unique, the name filter is a search, and lookups page", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  for (let index = 1; index <= 150; index++) await api.d1.create({ name: `app-a-${index}` });
  await api.d1.create({ name: "app-a" });

  const duplicate = await failure(api.d1.create({ name: "app-a" }));
  expect([duplicate.status, duplicate.has(7502)]).toEqual([400, true]);
  expect(fake.creates.d1).toBe(151);

  // `app-a` is the 151st match of the search, so `find` reads a second page.
  expect((await api.d1.find("app-a"))?.name).toBe("app-a");
  expect(fake.calls.filter((call) => call === "GET /d1/database")).toHaveLength(2);
  expect(await api.d1.find("app-b")).toBeUndefined();
});

test("D1: read replication, export and delete", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  const { uuid } = await api.d1.create({ name: "app", jurisdiction: "eu" });
  expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);

  expect((await api.d1.enableReadReplication(uuid)).read_replication).toEqual({ mode: "auto" });

  fake.state.d1.databases[0].sql = "CREATE TABLE t (id TEXT);\n";
  const done = await api.d1.export(uuid, noWait);
  expect(fake.calls.filter((call) => call.endsWith("/export"))).toHaveLength(2);
  const download = await fake.fetch(done.signedUrl);
  expect(await download.text()).toBe("CREATE TABLE t (id TEXT);\n");
  expect(done.signedUrl).toContain(done.filename);

  expect(await api.d1.delete(uuid)).toBe(true);
  expect(await api.d1.delete(uuid)).toBe(false);
  const missing = await failure(api.d1.enableReadReplication(uuid));
  expect([missing.status, missing.has(7404)]).toEqual([404, true]);
});

test("KV: namespaces, bulk writes, raw values and paged keys", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  const { id } = await api.kv.create({ title: "cache" });
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect((await failure(api.kv.create({ title: "cache" }))).has(10014)).toBe(true);
  expect(await api.kv.find("cache")).toMatchObject({ id, title: "cache" });

  await api.kv.putMany(id, [
    { key: "a/1", value: "one", metadata: { v: 1 } },
    { key: "a/2", value: btoa("two"), base64: true },
    { key: "b/1", value: "other" },
    { key: "with/slash?and#hash", value: "odd" },
  ]);
  expect(await api.kv.getText(id, "a/1")).toBe("one");
  expect(await api.kv.getText(id, "a/2")).toBe("two");
  expect(await api.kv.getText(id, "with/slash?and#hash")).toBe("odd");
  expect(await api.kv.getText(id, "missing")).toBeUndefined();
  expect(await api.kv.listKeys(id, { prefix: "a/" })).toEqual(["a/1", "a/2"]);
  expect(fake.state.kv.namespaces[0].values.get("a/1")).toEqual({
    value: "one",
    base64: false,
    metadata: { v: 1 },
  });

  await api.kv.deleteMany(id, ["a/1", "never-there"]);
  expect(await api.kv.getText(id, "a/1")).toBeUndefined();

  // 2,500 keys come back over three pages of 1,000.
  const many = Array.from({ length: 2500 }, (_, index) => ({
    key: `page/${String(index).padStart(4, "0")}`,
    value: "x",
  }));
  await api.kv.putMany(id, many);
  const keys = await api.kv.listKeys(id, { prefix: "page/" });
  expect(keys).toEqual(many.map((entry) => entry.key));
  expect(fake.calls.filter((call) => call.endsWith("/keys"))).toHaveLength(1 + 3);

  expect(await api.kv.delete(id)).toBe(true);
  expect(await api.kv.delete(id)).toBe(false);
  expect((await failure(api.kv.putMany(id, []))).has(10013)).toBe(true);
});

test("R2: buckets live under their jurisdiction, and a bucket with objects stays", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  await api.r2.create({ name: "uploads", jurisdiction: "eu" });
  expect(await api.r2.get("uploads")).toBeUndefined();
  expect(await api.r2.get("uploads", "eu")).toMatchObject({ name: "uploads", jurisdiction: "eu" });

  const conflict = await failure(api.r2.create({ name: "uploads", jurisdiction: "eu" }));
  expect([conflict.status, conflict.has(10073)]).toEqual([409, true]);
  expect((await failure(api.r2.create({ name: "Not_Valid" }))).has(10005)).toBe(true);

  const lifecycle = [
    {
      id: "expire-tmp",
      enabled: true,
      conditions: { prefix: "tmp/" },
      deleteObjectsTransition: { condition: { type: "Age" as const, maxAge: 86_400 } },
    },
  ];
  await api.r2.putLifecycle("uploads", lifecycle, "eu");
  expect(await api.r2.getLifecycle("uploads", "eu")).toEqual(lifecycle);
  const lock = [{ id: "keep", enabled: true, condition: { type: "Indefinite" as const } }];
  await api.r2.putLock("uploads", lock, "eu");
  expect(await api.r2.getLock("uploads", "eu")).toEqual(lock);
  expect((await failure(api.r2.getLock("uploads"))).has(10006)).toBe(true);

  fake.state.r2.buckets[0].objects = 3;
  const notEmpty = await failure(api.r2.delete("uploads", "eu"));
  expect([notEmpty.status, notEmpty.has(10008)]).toEqual([409, true]);
  fake.state.r2.buckets[0].objects = 0;
  expect(await api.r2.delete("uploads", "eu")).toBe(true);
  expect(await api.r2.delete("uploads", "eu")).toBe(false);
});

test("dispatch: a missing script answers 200 with script null", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  const raw = await fake.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${fake.accountId}/workers/dispatch/namespaces/apps/scripts/acme`,
    { headers: { authorization: `Bearer ${fake.token}` } },
  );
  expect(raw.status).toBe(200);
  expect(await raw.json()).toMatchObject({ success: true, result: { script: null } });
  expect(await api.dispatch.getScript("apps", "acme")).toBeUndefined();
  expect(await api.dispatch.deleteScript("apps", "acme")).toBe(false);
});

test("dispatch: uploads check modules, D1 ids and Durable Object migrations", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  const metadata = { main_module: "index.js", compatibility_date: "2026-11-01", bindings: [] };
  const upload = (extra: object, modules = [worker()]) =>
    api.dispatch.uploadScript("apps", "acme", {
      metadata: { ...metadata, ...extra },
      modules,
    });

  expect((await failure(upload({}, [worker("other.js")]))).has(10021)).toBe(true);
  expect(
    (await failure(upload({ bindings: [{ type: "d1", name: "DB", database_id: "x" }] }))).has(
      10021,
    ),
  ).toBe(true);
  const room = { type: "durable_object_namespace" as const, name: "ROOM", class_name: "Room" };
  expect((await failure(upload({ bindings: [room] }))).has(10061)).toBe(true);
  expect(fake.creates.scripts).toBe(0);

  const first = await upload({
    bindings: [room],
    migrations: { new_tag: "v1", steps: [{ new_sqlite_classes: ["Room"] }] },
  });
  expect(first).toMatchObject({ id: "acme", migration_tag: "v1" });

  // The next migration must start from v1.
  const stale = await failure(
    upload({ bindings: [room], migrations: { new_tag: "v2", steps: [] } }),
  );
  expect(stale.has(10079)).toBe(true);
  await upload({
    bindings: [{ ...room, class_name: "Lobby" }],
    migrations: {
      old_tag: "v1",
      new_tag: "v2",
      steps: [{ renamed_classes: [{ from: "Room", to: "Lobby" }] }],
    },
  });
  const script = fake.state.dispatch.scripts[0];
  expect([script.migrationTag, script.durableObjectClasses, script.uploads]).toEqual([
    "v2",
    ["Lobby"],
    2,
  ]);
  expect(script.modules.get("index.js")?.text).toContain("Response('ok')");
  expect(fake.creates.scripts).toBe(1);
  expect((await api.dispatch.getScript("apps", "acme"))?.script.migration_tag).toBe("v2");
});

test("dispatch: an upload drops secrets unless keep_bindings keeps them", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  const upload = (keep: string[] = []) =>
    api.dispatch.uploadScript("apps", "acme", {
      metadata: {
        main_module: "index.js",
        compatibility_date: "2026-11-01",
        bindings: [],
        keep_bindings: keep,
      },
      modules: [worker()],
    });
  expect(
    (await failure(api.dispatch.putSecret("apps", "acme", { name: "K", text: "v" }))).has(10007),
  ).toBe(true);

  await upload();
  await api.dispatch.putSecret("apps", "acme", { name: "API_KEY", text: "s3cret" });
  await upload(["secret_text"]);
  expect(fake.state.dispatch.scripts[0].secrets.get("API_KEY")).toBe("s3cret");
  await upload();
  expect(fake.state.dispatch.scripts[0].secrets.size).toBe(0);
});

test("dispatch: tags replace and filter the listing", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  for (const [name, tags] of [
    ["a", ["customer", "eu"]],
    ["b", ["customer"]],
    ["c", ["internal"]],
  ] as const)
    await api.dispatch.uploadScript("apps", name, {
      metadata: {
        main_module: "index.js",
        compatibility_date: "2026-11-01",
        bindings: [],
        tags: [...tags],
      },
      modules: [worker()],
    });
  await api.dispatch.uploadScript("other", "d", {
    metadata: { main_module: "index.js", compatibility_date: "2026-11-01", bindings: [] },
    modules: [worker()],
  });

  const ids = async (tags?: string[]) =>
    (await api.dispatch.listScripts("apps", { tags })).map((script) => script.id);
  expect(await ids()).toEqual(["a", "b", "c"]);
  expect(await ids(["customer"])).toEqual(["a", "b"]);
  expect(await ids(["customer", "eu"])).toEqual(["a"]);

  expect(await api.dispatch.putTags("apps", "c", ["customer"])).toEqual(["customer"]);
  expect(await ids(["customer"])).toEqual(["a", "b", "c"]);
  expect(await api.dispatch.deleteScript("apps", "c", { force: true })).toBe(true);
  expect(fake.calls.at(-1)).toBe("DELETE /workers/dispatch/namespaces/apps/scripts/c");
});

test("auth, accounts and unknown routes answer as Cloudflare does", async () => {
  const fake = createFakeCloudflareApi({ token: "right" });
  const wrongToken = await failure(cloudflareApi({ ...fake, token: "wrong" }).d1.find("x"));
  expect([wrongToken.status, wrongToken.has(10000)]).toEqual([403, true]);
  const wrongAccount = await failure(
    cloudflareApi({ ...fake, accountId: "a".repeat(32) }).d1.find("x"),
  );
  expect([wrongAccount.status, wrongAccount.has(9109)]).toEqual([403, true]);
  expect(fake.calls).toEqual([]);

  const api = cloudflareApi(fake);
  const unknown = await failure(api.call("GET", "/workers/nothing-here"));
  expect([unknown.status, unknown.has(7000)]).toEqual([400, true]);
  await expect(fake.fetch("https://example.com/")).rejects.toThrow(/example\.com/);
});

test("failNext fails a call, or carries it out and loses the answer", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);

  fake.failNext("POST", /^\/d1\/database$/);
  expect((await failure(api.d1.create({ name: "app" }))).status).toBe(500);
  expect(fake.state.d1.databases).toHaveLength(0);

  // Cloudflare created the database but the answer was lost: a blind retry is refused.
  fake.failNext("POST", /^\/d1\/database$/, { apply: true, status: 502 });
  expect((await failure(api.d1.create({ name: "app" }))).status).toBe(502);
  expect(fake.creates.d1).toBe(1);
  expect((await failure(api.d1.create({ name: "app" }))).has(7502)).toBe(true);

  fake.failNext("POST", /^\/storage\/kv\/namespaces$/, { skip: 1, times: 2, code: 10013 });
  await api.kv.create({ title: "one" });
  expect((await failure(api.kv.create({ title: "two" }))).has(10013)).toBe(true);
  expect((await failure(api.kv.create({ title: "two" }))).has(10013)).toBe(true);
  await api.kv.create({ title: "two" });

  fake.failNext("GET", /^\/r2\/buckets\//, { network: true });
  await expect(api.r2.get("x")).rejects.toThrow("fetch failed");

  fake.failNext("GET", /./, { times: 5 });
  fake.clearFailures();
  expect(await api.r2.get("x")).toBeUndefined();
});

test("failNext fails every matching call when the pattern is global or sticky", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi(fake);
  const { id } = await api.kv.create({ title: "cache" });
  const put = () => api.kv.putMany(id, [{ key: "k", value: "v" }]);
  const global = /\/bulk$/g;
  const sticky = /^\/storage\/kv\/namespaces\/\w+\/bulk$/y;
  for (const pattern of [global, sticky]) {
    fake.failNext("PUT", pattern, { times: 2 });
    expect((await failure(put())).status).toBe(500);
    expect((await failure(put())).status).toBe(500);
    await put();
    expect(pattern.lastIndex).toBe(0);
  }

  // A sticky pattern still matches only from the start of the path.
  fake.failNext("PUT", /\/bulk$/y);
  await put();
});

test("the client's retry rides out transient failures the fake injects", async () => {
  const fake = createFakeCloudflareApi();
  const api = cloudflareApi({ ...fake, retry: { attempts: 3, sleep: async () => {} } });
  const { id } = await api.kv.create({ title: "cache" });

  fake.failNext("PUT", /\/bulk$/, { times: 2, status: 503 });
  await api.kv.putMany(id, [{ key: "k", value: "v" }]);
  expect(fake.calls.filter((call) => call.endsWith("/bulk"))).toHaveLength(3);

  // A create is never sent twice, so its failure reaches the caller.
  fake.failNext("POST", /^\/storage\/kv\/namespaces$/, { status: 500 });
  expect((await failure(api.kv.create({ title: "other" }))).status).toBe(500);
});
