import { describe, expect, it } from "vitest";

import { CloudflareApiError, cloudflareApi } from "../src/cloudflare-api.js";
import type { CloudflareApiOptions } from "../src/cloudflare-api.js";

const isString = (value: unknown): value is string => typeof value === "string";

/** The `result_info` a paged or cursored answer carries. */
interface ResultInfo {
  page?: number;
  per_page?: number;
  total_pages?: number;
  total_count?: number;
  count?: number;
  cursor?: string;
}

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

const fakeApi = (
  handler: (call: Call) => { status?: number; body: unknown },
  options: Pick<CloudflareApiOptions, "retry"> = {}
) => {
  const calls: Call[] = [];

  // SAFETY: the client only calls fetch with a URL string and an init, which this answers
  const transport =
    // oxlint-disable-next-line eslint/require-await -- a fetch answers a promise even when this fake needs nothing from one
    (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const raw = init?.body;
      let body: unknown;

      if (raw instanceof FormData) {
        body = raw;
      } else if (isString(raw)) {
        body = JSON.parse(raw);
      }

      const call = {
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        headers,
        body,
      };

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
};

const ok = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a test answers whatever JSON the endpoint it fakes documents
  result: unknown,
  extra: { result_info?: ResultInfo } = {}
) => ({
  body: { success: true, errors: [], result, ...extra },
});

describe(cloudflareApi, () => {
  it("sends the bearer token and reads the envelope's result", async () => {
    const { api, calls } = fakeApi(() => ok([{ uuid: "db-1", name: "app-a" }]));
    await expect(api.d1.find("app-a")).resolves.toStrictEqual({
      uuid: "db-1",
      name: "app-a",
    });
    expect(calls[0].url.pathname).toBe(
      `/client/v4/accounts/${"a".repeat(32)}/d1/database`
    );
    expect(calls[0].url.searchParams.get("name")).toBe("app-a");
    expect(calls[0].headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("a failing status and envelope throw a CloudflareApiError that hides the token", async () => {
    const failing = fakeApi(() => ({
      status: 400,
      body: { success: false, errors: [{ code: 7400, message: "bad" }] },
    }));

    const error = await failing.api.d1
      .create({ name: "x" })
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected promise carries whatever was thrown
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(CloudflareApiError);
    // SAFETY: the assertion above showed this is the client's own error
    expect((error as CloudflareApiError).has(7400)).toBeTruthy();
    // The message names the call and the codes, never the token.
    // SAFETY: the assertion above showed this is the client's own error
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("a D1 name search only matches the exact name", async () => {
    const { api } = fakeApi(() => ok([{ uuid: "db-2", name: "app-ab" }]));
    await expect(api.d1.find("app-a")).resolves.toBeUndefined();
  });

  it("a D1 name search pages through its matches to the exact name", async () => {
    // A hundred databases whose names contain the one wanted fill the first page.
    const similar = Array.from({ length: 100 }, (_, index) => ({
      uuid: `db-${index}`,
      name: `app-a-${index + 1}`,
    }));

    const { api, calls } = fakeApi(({ url }) =>
      url.searchParams.get("page") === "1"
        ? ok(similar, { result_info: { page: 1, total_pages: 2 } })
        : ok([{ uuid: "db-wanted", name: "app-a" }], {
            result_info: { page: 2, total_pages: 2 },
          })
    );

    await expect(api.d1.find("app-a")).resolves.toStrictEqual({
      uuid: "db-wanted",
      name: "app-a",
    });
    expect(calls.map(({ url }) => url.searchParams.get("page"))).toStrictEqual([
      "1",
      "2",
    ]);
    expect(calls[1].url.searchParams.get("name")).toBe("app-a");
    expect(calls[1].url.searchParams.get("per_page")).toBe("100");
  });

  it("D1 create sends replication and drops the location hint under a jurisdiction", async () => {
    const { api, calls } = fakeApi(() => ok({ uuid: "db-1", name: "n" }));
    await api.d1.create({
      name: "n",
      jurisdiction: "eu",
      primaryLocationHint: "weur",
      readReplication: true,
    });
    await api.d1.create({ name: "m", primaryLocationHint: "enam" });
    expect(calls.map((call) => call.body)).toStrictEqual([
      { name: "n", jurisdiction: "eu", read_replication: { mode: "auto" } },
      { name: "m", primary_location_hint: "enam" },
    ]);
  });

  it("a D1 export polls with its bookmark until the signed URL is ready", async () => {
    let polls = 0;

    const { api, calls } = fakeApi(() => {
      polls += 1;

      return polls < 3
        ? ok({ at_bookmark: `b${polls}`, status: "active" })
        : ok({
            status: "complete",
            result: { signed_url: "https://r2.test/x", filename: "x.sql" },
          });
    });

    await expect(
      api.d1.export("db-1", { sleep: async () => {} })
    ).resolves.toStrictEqual({
      signedUrl: "https://r2.test/x",
      filename: "x.sql",
    });
    expect(
      // SAFETY: the export endpoint takes a JSON body, which the fake transport parsed back
      calls.map(
        (call) => (call.body as { current_bookmark?: string }).current_bookmark
      )
    ).toStrictEqual([undefined, "b1", "b2"]);
  });

  it("KV lookups page through every namespace", async () => {
    const { api, calls } = fakeApi(({ url }) => {
      const page = Number(url.searchParams.get("page"));

      const items =
        page === 1
          ? Array.from({ length: 100 }, (_, i) => ({
              id: `kv-${i}`,
              title: `other-${i}`,
            }))
          : [{ id: "kv-wanted", title: "app-a" }];

      return ok(items, {
        result_info: { page, per_page: 100, total_count: 101 },
      });
    });

    await expect(api.kv.find("app-a")).resolves.toStrictEqual({
      id: "kv-wanted",
      title: "app-a",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("per_page")).toBe("100");
  });

  it("KV key listings follow the cursor, and bulk writes and deletes send one array", async () => {
    const { api, calls } = fakeApi(({ url }) => {
      if (!url.pathname.endsWith("/keys")) {
        return ok({ successful_key_count: 1, unsuccessful_keys: [] });
      }

      return url.searchParams.get("cursor")
        ? ok([{ name: "assets/b.js" }], {
            result_info: { count: 1, cursor: "" },
          })
        : ok([{ name: "assets/a.js" }], {
            result_info: { count: 1, cursor: "next" },
          });
    });

    await expect(
      api.kv.listKeys("ns", { prefix: "assets/" })
    ).resolves.toStrictEqual(["assets/a.js", "assets/b.js"]);
    expect(
      calls.map((call) => call.url.searchParams.get("prefix"))
    ).toStrictEqual(["assets/", "assets/"]);
    expect(calls[1].url.searchParams.get("cursor")).toBe("next");

    await api.kv.putMany("ns", [
      { key: "assets/a.js", value: "YQ==", base64: true },
    ]);
    await api.kv.deleteMany("ns", ["assets/a.js"]);
    expect(
      calls
        .slice(2)
        .map(({ method, url, body }) => [method, url.pathname, body])
    ).toStrictEqual([
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
    body: {
      success: false,
      errors: [{ code: 10_000, message: "internal error" }],
    },
  };

  it("with retry, a request safe to repeat is sent again after a 429 or 5xx, pausing longer each time", async () => {
    const pauses: number[] = [];
    let failures = 2;

    const { api, calls } = fakeApi(
      ({ method }) => {
        const failing = method === "GET" && failures > 0;
        failures -= 1;

        return failing
          ? internalError
          : ok([{ name: "assets/a.js" }], { result_info: { cursor: "" } });
      },
      {
        retry: {
          attempts: 3,
          delayMs: 10,
          sleep: (ms) => {
            pauses.push(ms);

            return Promise.resolve();
          },
        },
      }
    );

    await expect(
      api.kv.listKeys("ns", { prefix: "assets/" })
    ).resolves.toStrictEqual(["assets/a.js"]);
    expect(calls).toHaveLength(3);
    expect(pauses).toStrictEqual([10, 20]);

    // A bulk delete is a POST, but deleting the same keys twice changes nothing more.
    let deleteFailures = 1;

    const deletes = fakeApi(
      () => {
        const failing = deleteFailures > 0;
        deleteFailures -= 1;

        return failing ? internalError : ok({});
      },
      {
        retry: { attempts: 3, sleep: async () => {} },
      }
    );

    await deletes.api.kv.deleteMany("ns", ["assets/a.js"]);
    expect(deletes.calls).toHaveLength(2);
  });

  it("with retry, the last failure throws, and a create or a 4xx is sent once", async () => {
    const failing = fakeApi(() => internalError, {
      retry: { attempts: 3, sleep: async () => {} },
    });

    const error = await failing.api.kv
      .listKeys("ns")
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected promise carries whatever was thrown
      .catch((error_: unknown) => error_);

    // SAFETY: a failing call rejects with the client's own error
    expect((error as CloudflareApiError).status).toBe(500);
    expect(failing.calls).toHaveLength(3);

    // A create that failed may have created the namespace; sending it again could make a second.
    await failing.api.kv.create({ title: "t" }).catch(() => {});
    expect(failing.calls).toHaveLength(4);

    const refused = fakeApi(
      () => ({
        status: 403,
        body: { success: false, errors: [{ code: 10_000, message: "auth" }] },
      }),
      { retry: { attempts: 3, sleep: async () => {} } }
    );

    await refused.api.kv.listKeys("ns").catch(() => {});
    expect(refused.calls).toHaveLength(1);
  });

  it("with retry, a request that fails on the way is sent again; without it, it throws at once", async () => {
    let calls = 0;

    // SAFETY: the client only calls fetch with a URL string and an init
    const transport =
      // oxlint-disable-next-line eslint/require-await -- a fetch answers a promise even when this fake needs nothing from one
      (async () => {
        calls += 1;

        if (calls === 1) {
          throw new TypeError("fetch failed");
        }

        return new Response("value");
      }) as typeof fetch;

    const api = cloudflareApi({
      accountId: "a".repeat(32),
      token: "t",
      fetch: transport,
      retry: { attempts: 2, sleep: async () => {} },
    });

    await expect(api.kv.getText("ns", "record")).resolves.toBe("value");
    expect(calls).toBe(2);

    const once = fakeApi(() => internalError);
    await once.api.kv.listKeys("ns").catch(() => {});
    expect(once.calls).toHaveLength(1);
  });

  it("a KV value comes back raw, and a missing key is undefined", async () => {
    const paths: string[] = [];

    // SAFETY: the client only calls fetch with a URL string and an init
    const transport =
      // oxlint-disable-next-line eslint/require-await -- a fetch answers a promise even when this fake needs nothing from one
      (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        paths.push(url.pathname);

        if (url.pathname.endsWith("/values/record")) {
          return new Response('{"build":"b"}');
        }

        if (url.pathname.endsWith("/values/broken")) {
          return Response.json(
            { success: false, errors: [{ code: 10_000, message: "auth" }] },
            { status: 403 }
          );
        }

        return Response.json(
          {
            success: false,
            errors: [{ code: 10_009, message: "key not found" }],
          },
          { status: 404 }
        );
      }) as typeof fetch;

    const api = cloudflareApi({
      accountId: "a".repeat(32),
      token: "t",
      fetch: transport,
    });

    await expect(api.kv.getText("ns", "record")).resolves.toBe('{"build":"b"}');
    await expect(
      api.kv.getText("ns", "assets/missing.js")
    ).resolves.toBeUndefined();

    const error = await api.kv
      .getText("ns", "broken")
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected promise carries whatever was thrown
      .catch((error_: unknown) => error_);

    // SAFETY: a failing call rejects with the client's own error
    expect((error as CloudflareApiError).has(10_000)).toBeTruthy();
    // A key's slash is part of the key, not of the path.
    expect(paths[1]).toMatch(/\/values\/assets%2Fmissing\.js$/u);
  });

  it("R2 calls carry the jurisdiction header and a missing bucket is undefined", async () => {
    const { api, calls } = fakeApi(({ method }) =>
      method === "GET"
        ? {
            status: 404,
            body: {
              success: false,
              errors: [{ code: 10_006, message: "NoSuchBucket" }],
            },
          }
        : ok({ name: "app-a" })
    );

    await expect(api.r2.get("app-a", "eu")).resolves.toBeUndefined();
    await api.r2.create({
      name: "app-a",
      jurisdiction: "eu",
      locationHint: "weur",
    });
    await api.r2.create({ name: "app-b", locationHint: "enam" });
    expect(
      calls.map((call) => call.headers.get("cf-r2-jurisdiction"))
    ).toStrictEqual(["eu", "eu", null]);
    // The jurisdiction places a bucket; the hint applies only without one.
    expect(calls[1].body).toStrictEqual({ name: "app-a" });
    expect(calls[2].body).toStrictEqual({
      name: "app-b",
      locationHint: "enam",
    });
  });

  it("a namespace script answered with script null or 404 is undefined", async () => {
    const { api } = fakeApi(({ url }) => {
      if (url.pathname.endsWith("/customer-null")) {
        return ok({ dispatch_namespace: "customers-production", script: null });
      }

      if (url.pathname.endsWith("/customer-gone")) {
        return {
          status: 404,
          body: {
            success: false,
            errors: [{ code: 10_007, message: "missing" }],
          },
        };
      }

      return ok({
        dispatch_namespace: "customers-production",
        script: { id: "customer-a", migration_tag: "v2" },
      });
    });

    await expect(
      api.dispatch.getScript("customers-production", "customer-null")
    ).resolves.toBeUndefined();
    await expect(
      api.dispatch.getScript("customers-production", "customer-gone")
    ).resolves.toBeUndefined();
    await expect(
      api.dispatch.getScript("customers-production", "customer-a")
    ).resolves.toStrictEqual({
      script: { id: "customer-a", migration_tag: "v2" },
    });
  });

  it("a namespace script upload is multipart with metadata and one part per module", async () => {
    const { api, calls } = fakeApi(() =>
      ok({ id: "customer-a", migration_tag: "v1" })
    );

    await api.dispatch.uploadScript("customers-preview", "customer-a", {
      metadata: {
        main_module: "worker.js",
        compatibility_date: "2026-09-29",
        bindings: [{ type: "d1", name: "APP_DB", id: "db-1" }],
        keep_bindings: ["secret_text"],
        tags: ["customer:a"],
        migrations: {
          new_tag: "v1",
          steps: [{ new_sqlite_classes: ["RealtimeHub"] }],
        },
      },
      modules: [
        {
          name: "worker.js",
          content: "export default {}",
          type: "application/javascript+module",
        },
        {
          name: "index.js",
          content: "export {}",
          type: "application/javascript+module",
        },
      ],
    });
    const [call] = calls;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toMatch(
      /\/workers\/dispatch\/namespaces\/customers-preview\/scripts\/customer-a$/u
    );
    // SAFETY: an upload sends a multipart body, which the fake transport kept as the FormData it is
    const form = call.body as FormData;
    // SAFETY: uploadScript appends the metadata part as a Blob
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.main_module).toBe("worker.js");
    expect(metadata.bindings).toStrictEqual([
      { type: "d1", name: "APP_DB", id: "db-1" },
    ]);
  });

  it("a namespace script upload carries each module as its own part", async () => {
    const { api, calls } = fakeApi(() =>
      ok({ id: "customer-a", migration_tag: "v1" })
    );

    await api.dispatch.uploadScript("customers-preview", "customer-a", {
      metadata: {
        main_module: "worker.js",
        compatibility_date: "2026-09-29",
        bindings: [],
      },
      modules: [
        {
          name: "worker.js",
          content: "export default {}",
          type: "application/javascript+module",
        },
      ],
    });
    // SAFETY: an upload sends a multipart body, which the fake transport kept as the FormData it is
    const form = calls[0].body as FormData;
    // SAFETY: uploadScript appends each module as a named file part
    const main = form.get("worker.js") as File;
    expect(main.type).toBe("application/javascript+module");
    await expect(main.text()).resolves.toBe("export default {}");
  });

  it("deletes answer false for a resource that is already gone and pass force", async () => {
    const { api, calls } = fakeApi(({ method, url }) =>
      url.pathname.endsWith("/scripts/customer-a") && method === "DELETE"
        ? ok(null)
        : {
            status: 404,
            body: {
              success: false,
              errors: [{ code: 10_007, message: "gone" }],
            },
          }
    );

    await expect(
      api.dispatch.deleteScript("ns", "customer-a", { force: true })
    ).resolves.toBeTruthy();
    expect(calls[0].url.searchParams.get("force")).toBe("true");
    await expect(api.d1.delete("db-1")).resolves.toBeFalsy();
    await expect(api.kv.delete("kv-1")).resolves.toBeFalsy();
    await expect(api.r2.delete("app-a")).resolves.toBeFalsy();
  });
});
