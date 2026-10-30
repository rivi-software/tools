import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { KvEntry } from "../src/cloudflare-api.js";
import {
  type AssetRecord,
  RECORD_KEY,
  planRetention,
  previousAssetsTarget,
  readBuildFiles,
  retainBuildAssets,
} from "../src/retain-assets.js";

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n));
const at = (n: number) => day(n).toISOString();

test("the first deploy uploads its build and removes nothing", () => {
  const plan = planRetention({
    record: null,
    build: "a",
    files: ["assets/a.js", "assets/shared.css"],
    stored: [],
    now: day(0),
  });
  expect(plan.upload).toEqual(["assets/a.js", "assets/shared.css"]);
  expect(plan.remove).toEqual([]);
  expect(plan.record).toEqual({
    build: "a",
    at: at(0),
    files: { "assets/a.js": null, "assets/shared.css": null },
  });
});

test("a superseded build's files stay for seven days after the deploy that replaced them", () => {
  const record: AssetRecord = {
    build: "a",
    at: at(0),
    files: { "assets/a.js": null, "assets/shared.css": null },
  };
  const stored = ["assets/a.js", "assets/shared.css"];
  const next = planRetention({
    record,
    build: "b",
    files: ["assets/b.js", "assets/shared.css"],
    stored,
    now: day(3),
  });
  expect(next.upload).toEqual(["assets/b.js"]);
  expect(next.remove).toEqual([]);
  expect(next.record.files).toEqual({
    "assets/a.js": at(3),
    "assets/shared.css": null,
    "assets/b.js": null,
  });

  // Build a was live three days, but its file counts from b's deploy, not from a's.
  const later = { record: next.record, build: "c", stored: [...stored, "assets/b.js"] };
  const sixDays = planRetention({ ...later, files: ["assets/c.js"], now: day(9) });
  expect(sixDays.remove).toEqual([]);
  expect(sixDays.record.files["assets/a.js"]).toBe(at(3));
  const sevenDays = planRetention({ ...later, files: ["assets/c.js"], now: day(10) });
  expect(sevenDays.remove).toEqual(["assets/a.js"]);
  expect(sevenDays.record.files).not.toHaveProperty("assets/a.js");
  expect(sevenDays.record.files["assets/b.js"]).toBe(at(10));
});

test("a stored file the record does not know counts from now", () => {
  const plan = planRetention({
    record: null,
    build: "b",
    files: ["assets/b.js"],
    stored: ["assets/orphan.js"],
    now: day(20),
  });
  expect(plan.remove).toEqual([]);
  expect(plan.record.files["assets/orphan.js"]).toBe(at(20));
});

test("a rerun of the same deploy changes nothing, and a file that returns is live again", () => {
  const record: AssetRecord = {
    build: "b",
    at: at(3),
    files: { "assets/a.js": at(3), "assets/b.js": null },
  };
  const stored = ["assets/a.js", "assets/b.js"];
  const rerun = planRetention({ record, build: "b", files: ["assets/b.js"], stored, now: day(4) });
  expect(rerun.upload).toEqual([]);
  expect(rerun.remove).toEqual([]);
  expect(rerun.record.files).toEqual(record.files);

  const rollback = planRetention({
    record,
    build: "a",
    files: ["assets/a.js"],
    stored,
    now: day(4),
  });
  expect(rollback.record.files).toEqual({ "assets/a.js": null, "assets/b.js": at(4) });
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "retain-assets-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeBuild(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

function fakeStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: KvEntry[][] = [];
  const deletes: string[][] = [];
  const kv = {
    async getText(_namespace: string, key: string) {
      return values.get(key);
    },
    async listKeys(_namespace: string, input: { prefix?: string } = {}) {
      return [...values.keys()].filter((key) => key.startsWith(input.prefix ?? ""));
    },
    async putMany(_namespace: string, entries: KvEntry[]) {
      writes.push(entries);
      for (const entry of entries) values.set(entry.key, entry.value);
    },
    async deleteMany(_namespace: string, keys: string[]) {
      deletes.push(keys);
      for (const key of keys) values.delete(key);
    },
  };
  return { api: { kv } as never, values, writes, deletes };
}

test("reads a build's files under assets/ and leaves source maps and public files out", async () => {
  await writeBuild({
    "assets/index-1.js": "a",
    "assets/index-1.js.map": "{}",
    "assets/fonts/geist-2.woff2": "f",
    "favicon.ico": "i",
  });
  expect(await readBuildFiles(directory)).toEqual([
    "assets/fonts/geist-2.woff2",
    "assets/index-1.js",
  ]);
  await expect(readBuildFiles(join(directory, "missing"))).rejects.toThrow(/No build files/);
});

test("uploads new files with their type, removes expired ones and writes the record last", async () => {
  await writeBuild({ "assets/b.js": "export const b = 1;", "assets/b.css": "a{}" });
  const record: AssetRecord = {
    build: "a",
    at: at(0),
    files: { "assets/a.js": null, "assets/old.js": at(0) },
  };
  const store = fakeStore({
    [RECORD_KEY]: JSON.stringify(record),
    "assets/a.js": "a",
    "assets/old.js": "o",
  });
  const lines: string[] = [];
  await retainBuildAssets({
    ...store,
    namespaceId: "ns",
    clientDir: directory,
    build: "b",
    now: day(8),
    log: (line) => lines.push(line),
  });
  expect(store.writes[0]).toEqual([
    {
      key: "assets/b.css",
      value: Buffer.from("a{}").toString("base64"),
      base64: true,
      metadata: { contentType: "text/css; charset=utf-8" },
    },
    {
      key: "assets/b.js",
      value: Buffer.from("export const b = 1;").toString("base64"),
      base64: true,
      metadata: { contentType: "text/javascript; charset=utf-8" },
    },
  ]);
  expect(store.deletes).toEqual([["assets/old.js"]]);
  expect(store.writes.at(-1)?.map((entry) => entry.key)).toEqual([RECORD_KEY]);
  expect(JSON.parse(store.values.get(RECORD_KEY)!)).toEqual({
    build: "b",
    at: at(8),
    files: { "assets/a.js": at(8), "assets/b.css": null, "assets/b.js": null },
  });
  expect(lines).toEqual([
    "Earlier builds' client files: 2 in this build (2 new), 1 kept from earlier builds, 1 removed.",
  ]);
});

test("refuses a record it cannot read rather than treating the store as empty", async () => {
  await writeBuild({ "assets/b.js": "b" });
  const store = fakeStore({ [RECORD_KEY]: '{"files":[]}' });
  await expect(
    retainBuildAssets({ ...store, namespaceId: "ns", clientDir: directory, build: "b" }),
  ).rejects.toThrow(/not an asset record/);
  expect(store.writes).toEqual([]);
});

test("finds the store and build directory in a deploy config", () => {
  const config = {
    account_id: "a".repeat(32),
    assets: { directory: "../client" },
    kv_namespaces: [
      { binding: "KV", id: "1".repeat(32) },
      { binding: "PREVIOUS_ASSETS", id: "2".repeat(32) },
    ],
  };
  expect(previousAssetsTarget(config, "/app/dist/server/wrangler.json")).toEqual({
    accountId: "a".repeat(32),
    namespaceId: "2".repeat(32),
    clientDir: "/app/dist/client",
  });
  expect(() =>
    previousAssetsTarget({ ...config, kv_namespaces: [] }, "/app/dist/server/wrangler.json"),
  ).toThrow(/binds no PREVIOUS_ASSETS/);
});
