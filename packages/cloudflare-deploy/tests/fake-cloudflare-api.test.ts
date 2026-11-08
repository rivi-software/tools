import { describe, expect, it } from "vitest";

import type { CloudflareApiError } from "../src/cloudflare-api.js";
import { cloudflareApi } from "../src/cloudflare-api.js";
import { createFakeCloudflareApi } from "../src/fake-cloudflare-api.js";

const noWait = { sleep: async () => {} };

/** The error a call rejects with. */
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    // SAFETY: every call of the fake rejects with the client's own error
    return error as CloudflareApiError;
  }

  throw new Error("expected the call to fail");
};

const worker = (main = "index.js") => ({
  name: main,
  content: "export default { fetch() { return new Response('ok') } }",
  type: "application/javascript+module",
});

const connected = () => {
  const fake = createFakeCloudflareApi();

  return { fake, api: cloudflareApi(fake) };
};

const cached = async () => {
  const { fake, api } = connected();
  const { id } = await api.kv.create({ title: "cache" });

  return { fake, api, id };
};

describe(createFakeCloudflareApi, () => {
  it("the client works against the fake passed as its options", async () => {
    const { fake, api } = connected();
    const database = await api.d1.create({ name: "app" });
    expect(database).toMatchObject({
      name: "app",
      read_replication: { mode: "disabled" },
    });
    expect(fake.state.d1.databases.map((item) => item.name)).toStrictEqual([
      "app",
    ]);
    expect(fake.calls).toStrictEqual(["POST /d1/database"]);
    expect(fake.creates.d1).toBe(1);
  });

  describe("D1", () => {
    it("names are unique, the name filter is a search, and lookups page", async () => {
      const { fake, api } = connected();

      for (let index = 1; index <= 150; index += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the databases are created in order, so the paged search finds them in that order
        await api.d1.create({ name: `app-a-${index}` });
      }

      await api.d1.create({ name: "app-a" });

      const duplicate = await failure(api.d1.create({ name: "app-a" }));
      expect([duplicate.status, duplicate.has(7502)]).toStrictEqual([
        400,
        true,
      ]);
      expect(fake.creates.d1).toBe(151);

      // `app-a` is the 151st match of the search, so `find` reads a second page.
      const found = await api.d1.find("app-a");
      expect(found?.name).toBe("app-a");
      expect(
        fake.calls.filter((call) => call === "GET /d1/database")
      ).toHaveLength(2);
      await expect(api.d1.find("app-b")).resolves.toBeUndefined();
    });

    it("gives a database a UUID and turns on read replication", async () => {
      const { api } = connected();
      const { uuid } = await api.d1.create({ name: "app", jurisdiction: "eu" });
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u
      );

      const replicated = await api.d1.enableReadReplication(uuid);
      expect(replicated.read_replication).toStrictEqual({ mode: "auto" });
    });

    it("exports the database to a signed URL that serves its SQL", async () => {
      const { fake, api } = connected();
      const { uuid } = await api.d1.create({ name: "app" });
      fake.state.d1.databases[0].sql = "CREATE TABLE t (id TEXT);\n";
      const done = await api.d1.export(uuid, noWait);
      expect(
        fake.calls.filter((call) => call.endsWith("/export"))
      ).toHaveLength(2);
      const download = await fake.fetch(done.signedUrl);
      await expect(download.text()).resolves.toBe(
        "CREATE TABLE t (id TEXT);\n"
      );
      expect(done.signedUrl).toContain(done.filename);
    });

    it("delete answers false the second time, and a missing database is a 404", async () => {
      const { api } = connected();
      const { uuid } = await api.d1.create({ name: "app" });
      await expect(api.d1.delete(uuid)).resolves.toBeTruthy();
      await expect(api.d1.delete(uuid)).resolves.toBeFalsy();
      const missing = await failure(api.d1.enableReadReplication(uuid));
      expect([missing.status, missing.has(7404)]).toStrictEqual([404, true]);
    });
  });

  describe("KV", () => {
    it("gives a namespace a hex id, refuses a second one by the same title", async () => {
      const { api, id } = await cached();
      expect(id).toMatch(/^[0-9a-f]{32}$/u);
      const duplicate = await failure(api.kv.create({ title: "cache" }));
      expect(duplicate.has(10_014)).toBeTruthy();
      await expect(api.kv.find("cache")).resolves.toMatchObject({
        id,
        title: "cache",
      });
    });

    it("a bulk write stores text, base64 values and keys with odd characters", async () => {
      const { api, id } = await cached();
      await api.kv.putMany(id, [
        { key: "a/1", value: "one", metadata: { v: 1 } },
        { key: "a/2", value: btoa("two"), base64: true },
        { key: "b/1", value: "other" },
        { key: "with/slash?and#hash", value: "odd" },
      ]);
      await expect(api.kv.getText(id, "a/1")).resolves.toBe("one");
      await expect(api.kv.getText(id, "a/2")).resolves.toBe("two");
      await expect(api.kv.getText(id, "with/slash?and#hash")).resolves.toBe(
        "odd"
      );
      await expect(api.kv.getText(id, "missing")).resolves.toBeUndefined();
    });

    it("lists the keys under a prefix and keeps each value's metadata", async () => {
      const { fake, api, id } = await cached();
      await api.kv.putMany(id, [
        { key: "a/1", value: "one", metadata: { v: 1 } },
        { key: "a/2", value: btoa("two"), base64: true },
        { key: "b/1", value: "other" },
      ]);
      await expect(
        api.kv.listKeys(id, { prefix: "a/" })
      ).resolves.toStrictEqual(["a/1", "a/2"]);
      expect(fake.state.kv.namespaces[0].values.get("a/1")).toStrictEqual({
        value: "one",
        base64: false,
        metadata: { v: 1 },
      });
    });

    it("a bulk delete removes a key and ignores one that is not there", async () => {
      const { api, id } = await cached();
      await api.kv.putMany(id, [{ key: "a/1", value: "one" }]);
      await api.kv.deleteMany(id, ["a/1", "never-there"]);
      await expect(api.kv.getText(id, "a/1")).resolves.toBeUndefined();
    });

    it("pages a listing of 2,500 keys over three pages of 1,000", async () => {
      const { fake, api, id } = await cached();

      const many = Array.from({ length: 2500 }, (_, index) => ({
        key: `page/${String(index).padStart(4, "0")}`,
        value: "x",
      }));

      await api.kv.putMany(id, many);
      const keys = await api.kv.listKeys(id, { prefix: "page/" });
      expect(keys).toStrictEqual(many.map((entry) => entry.key));
      expect(fake.calls.filter((call) => call.endsWith("/keys"))).toHaveLength(
        3
      );
    });

    it("delete answers false the second time, and a write needs the namespace", async () => {
      const { api, id } = await cached();
      await expect(api.kv.delete(id)).resolves.toBeTruthy();
      await expect(api.kv.delete(id)).resolves.toBeFalsy();
      const gone = await failure(api.kv.putMany(id, []));
      expect(gone.has(10_013)).toBeTruthy();
    });
  });

  describe("R2", () => {
    it("a bucket is only found under the jurisdiction it was created in", async () => {
      const { api } = connected();
      await api.r2.create({ name: "uploads", jurisdiction: "eu" });
      await expect(api.r2.get("uploads")).resolves.toBeUndefined();
      await expect(api.r2.get("uploads", "eu")).resolves.toMatchObject({
        name: "uploads",
        jurisdiction: "eu",
      });
    });

    it("refuses a second bucket by the same name, and an invalid name", async () => {
      const { api } = connected();
      await api.r2.create({ name: "uploads", jurisdiction: "eu" });

      const conflict = await failure(
        api.r2.create({ name: "uploads", jurisdiction: "eu" })
      );

      expect([conflict.status, conflict.has(10_073)]).toStrictEqual([
        409,
        true,
      ]);
      const invalid = await failure(api.r2.create({ name: "Not_Valid" }));
      expect(invalid.has(10_005)).toBeTruthy();
    });

    it("keeps lifecycle and lock rules under the bucket's jurisdiction", async () => {
      const { api } = connected();
      await api.r2.create({ name: "uploads", jurisdiction: "eu" });

      const lifecycle = [
        {
          id: "expire-tmp",
          enabled: true,
          conditions: { prefix: "tmp/" },
          deleteObjectsTransition: {
            condition: { type: "Age" as const, maxAge: 86_400 },
          },
        },
      ];

      await api.r2.putLifecycle("uploads", lifecycle, "eu");
      await expect(api.r2.getLifecycle("uploads", "eu")).resolves.toStrictEqual(
        lifecycle
      );

      const lock = [
        {
          id: "keep",
          enabled: true,
          condition: { type: "Indefinite" as const },
        },
      ];

      await api.r2.putLock("uploads", lock, "eu");
      await expect(api.r2.getLock("uploads", "eu")).resolves.toStrictEqual(
        lock
      );
      const elsewhere = await failure(api.r2.getLock("uploads"));
      expect(elsewhere.has(10_006)).toBeTruthy();
    });

    it("a bucket that holds objects stays, and delete answers false the second time", async () => {
      const { fake, api } = connected();
      await api.r2.create({ name: "uploads", jurisdiction: "eu" });
      fake.state.r2.buckets[0].objects = 3;
      const notEmpty = await failure(api.r2.delete("uploads", "eu"));
      expect([notEmpty.status, notEmpty.has(10_008)]).toStrictEqual([
        409,
        true,
      ]);
      fake.state.r2.buckets[0].objects = 0;
      await expect(api.r2.delete("uploads", "eu")).resolves.toBeTruthy();
      await expect(api.r2.delete("uploads", "eu")).resolves.toBeFalsy();
    });
  });

  describe("dispatch", () => {
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2026-11-01",
      bindings: [],
    };

    const uploader = () => {
      const { fake, api } = connected();

      const upload = (
        // oxlint-disable-next-line anti-slop/no-object-parameters -- a test sends metadata WorkerMetadata does not model, such as a D1 binding without an id
        extra: object,
        modules = [worker()]
      ) =>
        api.dispatch.uploadScript("apps", "acme", {
          metadata: { ...metadata, ...extra },
          modules,
        });

      return { fake, api, upload };
    };

    const room = {
      type: "durable_object_namespace" as const,
      name: "ROOM",
      class_name: "Room",
    };

    const withRoom = {
      bindings: [room],
      migrations: { new_tag: "v1", steps: [{ new_sqlite_classes: ["Room"] }] },
    };

    it("a missing script answers 200 with script null", async () => {
      const { fake, api } = connected();

      const raw = await fake.fetch(
        `https://api.cloudflare.com/client/v4/accounts/${fake.accountId}/workers/dispatch/namespaces/apps/scripts/acme`,
        { headers: { authorization: `Bearer ${fake.token}` } }
      );

      expect(raw.status).toBe(200);
      await expect(raw.json()).resolves.toMatchObject({
        success: true,
        result: { script: null },
      });
      await expect(
        api.dispatch.getScript("apps", "acme")
      ).resolves.toBeUndefined();
      await expect(
        api.dispatch.deleteScript("apps", "acme")
      ).resolves.toBeFalsy();
    });

    it("refuses an upload whose main module, D1 id or Durable Object class is missing", async () => {
      const { fake, upload } = uploader();
      const noModule = await failure(upload({}, [worker("other.js")]));
      expect(noModule.has(10_021)).toBeTruthy();

      const noDatabaseId = await failure(
        upload({ bindings: [{ type: "d1", name: "DB", database_id: "x" }] })
      );

      expect(noDatabaseId.has(10_021)).toBeTruthy();
      const unbound = await failure(upload({ bindings: [room] }));
      expect(unbound.has(10_061)).toBeTruthy();
      expect(fake.creates.scripts).toBe(0);
    });

    it("a migration creates the Durable Object class its binding names", async () => {
      const { upload } = uploader();
      const first = await upload(withRoom);
      expect(first).toMatchObject({ id: "acme", migration_tag: "v1" });
    });

    it("the next migration must start from the script's current tag", async () => {
      const { upload } = uploader();
      await upload(withRoom);

      const stale = await failure(
        upload({ bindings: [room], migrations: { new_tag: "v2", steps: [] } })
      );

      expect(stale.has(10_079)).toBeTruthy();
    });

    it("a rename moves the class on, and the script counts as one create", async () => {
      const { fake, api, upload } = uploader();
      await upload(withRoom);
      await upload({
        bindings: [{ ...room, class_name: "Lobby" }],
        migrations: {
          old_tag: "v1",
          new_tag: "v2",
          steps: [{ renamed_classes: [{ from: "Room", to: "Lobby" }] }],
        },
      });
      const [script] = fake.state.dispatch.scripts;
      expect([
        script.migrationTag,
        script.durableObjectClasses,
        script.uploads,
      ]).toStrictEqual(["v2", ["Lobby"], 2]);
      expect(script.modules.get("index.js")?.text).toContain("Response('ok')");
      expect(fake.creates.scripts).toBe(1);
      const stored = await api.dispatch.getScript("apps", "acme");
      expect(stored?.script.migration_tag).toBe("v2");
    });

    it("an upload drops secrets unless keep_bindings keeps them", async () => {
      const { fake, api } = connected();

      const upload = (keep: string[] = []) =>
        api.dispatch.uploadScript("apps", "acme", {
          metadata: { ...metadata, keep_bindings: keep },
          modules: [worker()],
        });

      const noScript = await failure(
        api.dispatch.putSecret("apps", "acme", { name: "K", text: "v" })
      );

      expect(noScript.has(10_007)).toBeTruthy();

      await upload();
      await api.dispatch.putSecret("apps", "acme", {
        name: "API_KEY",
        text: "s3cret",
      });
      await upload(["secret_text"]);
      expect(fake.state.dispatch.scripts[0].secrets.get("API_KEY")).toBe(
        "s3cret"
      );
      await upload();
      expect(fake.state.dispatch.scripts[0].secrets.size).toBe(0);
    });

    const tagged = async () => {
      const { fake, api } = connected();

      for (const [name, tags] of [
        ["a", ["customer", "eu"]],
        ["b", ["customer"]],
        ["c", ["internal"]],
      ] as const) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the scripts go up in order, which is the order the listing answers
        await api.dispatch.uploadScript("apps", name, {
          metadata: { ...metadata, tags: [...tags] },
          modules: [worker()],
        });
      }

      await api.dispatch.uploadScript("other", "d", {
        metadata,
        modules: [worker()],
      });

      const ids = async (tags?: string[]) => {
        const scripts = await api.dispatch.listScripts("apps", { tags });

        return scripts.map((script) => script.id);
      };

      return { fake, api, ids };
    };

    it("lists a namespace's own scripts and filters them by tag", async () => {
      const { ids } = await tagged();
      await expect(ids()).resolves.toStrictEqual(["a", "b", "c"]);
      await expect(ids(["customer"])).resolves.toStrictEqual(["a", "b"]);
      await expect(ids(["customer", "eu"])).resolves.toStrictEqual(["a"]);
    });

    it("putTags replaces a script's tags, and a forced delete removes it", async () => {
      const { fake, api, ids } = await tagged();
      await expect(
        api.dispatch.putTags("apps", "c", ["customer"])
      ).resolves.toStrictEqual(["customer"]);
      await expect(ids(["customer"])).resolves.toStrictEqual(["a", "b", "c"]);
      await expect(
        api.dispatch.deleteScript("apps", "c", { force: true })
      ).resolves.toBeTruthy();
      expect(fake.calls.at(-1)).toBe(
        "DELETE /workers/dispatch/namespaces/apps/scripts/c"
      );
    });
  });

  it("auth, accounts and unknown routes answer as Cloudflare does", async () => {
    const fake = createFakeCloudflareApi({ token: "right" });

    const wrongToken = await failure(
      cloudflareApi({ ...fake, token: "wrong" }).d1.find("x")
    );

    expect([wrongToken.status, wrongToken.has(10_000)]).toStrictEqual([
      403,
      true,
    ]);

    const wrongAccount = await failure(
      cloudflareApi({ ...fake, accountId: "a".repeat(32) }).d1.find("x")
    );

    expect([wrongAccount.status, wrongAccount.has(9109)]).toStrictEqual([
      403,
      true,
    ]);
    expect(fake.calls).toStrictEqual([]);

    const api = cloudflareApi(fake);
    const unknown = await failure(api.call("GET", "/workers/nothing-here"));
    expect([unknown.status, unknown.has(7000)]).toStrictEqual([400, true]);
    await expect(fake.fetch("https://example.com/")).rejects.toThrow(
      /example\.com/u
    );
  });

  describe("failNext", () => {
    it("fails the next matching call, and nothing is created", async () => {
      const { fake, api } = connected();
      fake.failNext("POST", /^\/d1\/database$/u);
      const lost = await failure(api.d1.create({ name: "app" }));
      expect(lost.status).toBe(500);
      expect(fake.state.d1.databases).toHaveLength(0);
    });

    it("with apply, carries the call out and loses the answer", async () => {
      const { fake, api } = connected();
      // Cloudflare created the database but the answer was lost: a blind retry is refused.
      fake.failNext("POST", /^\/d1\/database$/u, { apply: true, status: 502 });
      const lost = await failure(api.d1.create({ name: "app" }));
      expect(lost.status).toBe(502);
      expect(fake.creates.d1).toBe(1);
      const retried = await failure(api.d1.create({ name: "app" }));
      expect(retried.has(7502)).toBeTruthy();
    });

    it("skip and times decide which matching calls fail", async () => {
      const { fake, api } = connected();
      fake.failNext("POST", /^\/storage\/kv\/namespaces$/u, {
        skip: 1,
        times: 2,
        code: 10_013,
      });
      await api.kv.create({ title: "one" });
      const first = await failure(api.kv.create({ title: "two" }));
      expect(first.has(10_013)).toBeTruthy();
      const second = await failure(api.kv.create({ title: "two" }));
      expect(second.has(10_013)).toBeTruthy();
      await api.kv.create({ title: "two" });
    });

    it("network rejects the call, and clearFailures drops what is left", async () => {
      const { fake, api } = connected();
      fake.failNext("GET", /^\/r2\/buckets\//u, { network: true });
      await expect(api.r2.get("x")).rejects.toThrow("fetch failed");

      fake.failNext("GET", /./u, { times: 5 });
      fake.clearFailures();
      await expect(api.r2.get("x")).resolves.toBeUndefined();
    });

    it("fails every matching call when the pattern is global or sticky", async () => {
      const { fake, api } = connected();
      const { id } = await api.kv.create({ title: "cache" });
      const put = () => api.kv.putMany(id, [{ key: "k", value: "v" }]);
      const global = /\/bulk$/gu;
      const sticky = /^\/storage\/kv\/namespaces\/\w+\/bulk$/uy;

      for (const pattern of [global, sticky]) {
        fake.failNext("PUT", pattern, { times: 2 });
        // oxlint-disable-next-line eslint/no-await-in-loop -- the injected failures are used up one call at a time
        const first = await failure(put());
        expect(first.status).toBe(500);
        // oxlint-disable-next-line eslint/no-await-in-loop -- the injected failures are used up one call at a time
        const second = await failure(put());
        expect(second.status).toBe(500);
        // oxlint-disable-next-line eslint/no-await-in-loop -- the call that goes through follows the two that failed
        await put();
        expect(pattern.lastIndex).toBe(0);
      }

      // A sticky pattern still matches only from the start of the path.
      fake.failNext("PUT", /\/bulk$/uy);
      await put();
    });
  });

  it("the client's retry rides out transient failures the fake injects", async () => {
    const fake = createFakeCloudflareApi();

    const api = cloudflareApi({
      ...fake,
      retry: { attempts: 3, sleep: async () => {} },
    });

    const { id } = await api.kv.create({ title: "cache" });

    fake.failNext("PUT", /\/bulk$/u, { times: 2, status: 503 });
    await api.kv.putMany(id, [{ key: "k", value: "v" }]);
    expect(fake.calls.filter((call) => call.endsWith("/bulk"))).toHaveLength(3);

    // A create is never sent twice, so its failure reaches the caller.
    fake.failNext("POST", /^\/storage\/kv\/namespaces$/u, { status: 500 });
    const refused = await failure(api.kv.create({ title: "other" }));
    expect(refused.status).toBe(500);
  });
});
