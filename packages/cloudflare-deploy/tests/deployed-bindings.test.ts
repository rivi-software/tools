import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertDeployedBindings } from "../src/index.js";

const D1_ID = "6f1c2b9e-4d3a-4b8f-9e2d-1a5c7b3e8f40";
const KV_ID = "0123456789abcdef0123456789abcdef";

const d1 = (database_id?: unknown) => ({ binding: "DB", database_name: "app", database_id });
const kv = (id?: unknown) => ({ binding: "CACHE", id });

describe("assertDeployedBindings", () => {
  test("passes real ids, and bindings Wrangler provisions because they have none", async () => {
    await expect(
      assertDeployedBindings({
        d1_databases: [d1(D1_ID), d1(D1_ID.toUpperCase()), { binding: "NEW_DB" }],
        kv_namespaces: [kv(KV_ID), { binding: "NEW_KV" }],
      }),
    ).resolves.toBeUndefined();
    await expect(assertDeployedBindings({})).resolves.toBeUndefined();
  });

  test("lists every placeholder in one error", async () => {
    const error = await assertDeployedBindings({
      d1_databases: [
        d1("<PREVIEW_DATABASE_ID>"),
        { binding: "ZERO", database_id: "00000000-0000-0000-0000-000000000000" },
        { binding: "LOCAL", database_id: "local" },
      ],
      kv_namespaces: [
        kv("TODO"),
        { binding: "ZERO", id: "0".repeat(32) },
        { binding: "SHORT", id: KV_ID.slice(1) },
        { id: "" },
      ],
    }).catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      [
        "The config has placeholder binding ids:",
        '  d1_databases[DB].database_id = "<PREVIEW_DATABASE_ID>"',
        '  d1_databases[ZERO].database_id = "00000000-0000-0000-0000-000000000000"',
        '  d1_databases[LOCAL].database_id = "local"',
        '  kv_namespaces[CACHE].id = "TODO"',
        `  kv_namespaces[ZERO].id = "${"0".repeat(32)}"`,
        `  kv_namespaces[SHORT].id = "${KV_ID.slice(1)}"`,
        '  kv_namespaces[3].id = ""',
        "A D1 database_id is a UUID and a KV namespace id is 32 hexadecimal characters, neither all zeros.",
      ].join("\n"),
    );
  });

  test("refuses an id that is not a string", async () => {
    await expect(assertDeployedBindings({ kv_namespaces: [kv(null)] })).rejects.toThrow(
      "kv_namespaces[CACHE].id = null",
    );
  });

  test("checks the block that deploys: the top level, an environment, or its Previews", async () => {
    const config = {
      d1_databases: [d1(D1_ID)],
      previews: { d1_databases: [d1("<PREVIEW_DATABASE_ID>")] },
      env: {
        staging: { kv_namespaces: [kv("TODO")], previews: { kv_namespaces: [kv(KV_ID)] } },
      },
    };
    await expect(assertDeployedBindings(config)).resolves.toBeUndefined();
    await expect(assertDeployedBindings(config, { previews: true })).rejects.toThrow(
      'previews.d1_databases[DB].database_id = "<PREVIEW_DATABASE_ID>"',
    );
    await expect(assertDeployedBindings(config, { environment: "staging" })).rejects.toThrow(
      'env.staging.kv_namespaces[CACHE].id = "TODO"',
    );
    await expect(
      assertDeployedBindings(config, { environment: "staging", previews: true }),
    ).resolves.toBeUndefined();
  });

  test("refuses a block the config does not have", async () => {
    await expect(assertDeployedBindings({}, { environment: "production" })).rejects.toThrow(
      "The config has no env.production block",
    );
    await expect(assertDeployedBindings({}, { previews: true })).rejects.toThrow(
      "The config has no previews block",
    );
  });

  describe("from a file", () => {
    let directory: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "deployed-bindings-"));
    });
    afterEach(() => rm(directory, { recursive: true, force: true }));

    const file = async (name: string, text: string) => {
      const path = join(directory, name);
      await writeFile(path, text);
      return path;
    };

    test("reads the wrangler.json the Vite plugin writes, and names it in the error", async () => {
      const path = await file(
        "wrangler.json",
        JSON.stringify({ d1_databases: [d1("<PREVIEW_DATABASE_ID>")], kv_namespaces: [kv(KV_ID)] }),
      );
      await expect(assertDeployedBindings(path)).rejects.toThrow(
        `${path} has placeholder binding ids:\n  d1_databases[DB].database_id = "<PREVIEW_DATABASE_ID>"\n`,
      );
    });

    test("reads JSONC: comments and trailing commas, but never inside a string", async () => {
      const path = await file(
        "wrangler.jsonc",
        `\uFEFF{
  // The production database.
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "${D1_ID}", },
  ],
  /* KV, with an id that looks like a comment and a trailing comma. */
  "kv_namespaces": [{ "binding": "CACHE", "id": "TODO // ,]" }],
  "vars": { "ORIGIN": "https://app.example.com", "ESCAPED": "a \\"/*\\" b", },
}
`,
      );
      await expect(assertDeployedBindings(path)).rejects.toThrow(
        'kv_namespaces[CACHE].id = "TODO // ,]"',
      );
    });

    test("refuses a TOML config, a file that is not JSON and one that holds no object", async () => {
      await expect(assertDeployedBindings(await file("wrangler.toml", ""))).rejects.toThrow(
        "parse a TOML config yourself and pass the object",
      );
      await expect(assertDeployedBindings(await file("broken.json", "{ nope"))).rejects.toThrow(
        "broken.json is not valid JSON",
      );
      await expect(assertDeployedBindings(await file("list.json", "[]"))).rejects.toThrow(
        "list.json holds no Wrangler config object",
      );
      await expect(assertDeployedBindings(join(directory, "missing.json"))).rejects.toThrow(
        "ENOENT",
      );
    });
  });
});
