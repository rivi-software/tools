import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KvEntry } from "../src/cloudflare-api.js";
import {
  RECORD_KEY,
  planRetention,
  previousAssetsTarget,
  readBuildFiles,
  retainBuildAssets,
} from "../src/retain-assets.js";
import type { AssetRecord } from "../src/retain-assets.js";

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n));
const at = (n: number) => day(n).toISOString();

describe(planRetention, () => {
  it("the first deploy uploads its build and removes nothing", () => {
    const plan = planRetention({
      record: null,
      build: "a",
      files: ["assets/a.js", "assets/shared.css"],
      stored: [],
      now: day(0),
    });

    expect(plan.upload).toStrictEqual(["assets/a.js", "assets/shared.css"]);
    expect(plan.remove).toStrictEqual([]);
    expect(plan.record).toStrictEqual({
      build: "a",
      at: at(0),
      files: { "assets/a.js": null, "assets/shared.css": null },
    });
  });

  const storedByA = ["assets/a.js", "assets/shared.css"];

  /** Build b replaces build a, which leaves `assets/a.js` behind from day 3. */
  const afterBuildB = () =>
    planRetention({
      record: {
        build: "a",
        at: at(0),
        files: { "assets/a.js": null, "assets/shared.css": null },
      },
      build: "b",
      files: ["assets/b.js", "assets/shared.css"],
      stored: storedByA,
      now: day(3),
    });

  it("a superseded build's files stay for seven days after the deploy that replaced them", () => {
    const next = afterBuildB();

    expect(next.upload).toStrictEqual(["assets/b.js"]);
    expect(next.remove).toStrictEqual([]);
    expect(next.record.files).toStrictEqual({
      "assets/a.js": at(3),
      "assets/shared.css": null,
      "assets/b.js": null,
    });

    // Build a was live three days, but its file counts from b's deploy, not from a's.
    const sixDays = planRetention({
      record: next.record,
      build: "c",
      stored: [...storedByA, "assets/b.js"],
      files: ["assets/c.js"],
      now: day(9),
    });

    expect(sixDays.remove).toStrictEqual([]);
    expect(sixDays.record.files["assets/a.js"]).toBe(at(3));
  });

  it("removes a superseded build's file once the seven days are up", () => {
    const sevenDays = planRetention({
      record: afterBuildB().record,
      build: "c",
      stored: [...storedByA, "assets/b.js"],
      files: ["assets/c.js"],
      now: day(10),
    });

    expect(sevenDays.remove).toStrictEqual(["assets/a.js"]);
    expect(sevenDays.record.files).not.toHaveProperty("assets/a.js");
    expect(sevenDays.record.files["assets/b.js"]).toBe(at(10));
  });

  it("a stored file the record does not know counts from now", () => {
    const plan = planRetention({
      record: null,
      build: "b",
      files: ["assets/b.js"],
      stored: ["assets/orphan.js"],
      now: day(20),
    });

    expect(plan.remove).toStrictEqual([]);
    expect(plan.record.files["assets/orphan.js"]).toBe(at(20));
  });

  it("a rerun of the same deploy changes nothing, and a file that returns is live again", () => {
    const record: AssetRecord = {
      build: "b",
      at: at(3),
      files: { "assets/a.js": at(3), "assets/b.js": null },
    };

    const stored = ["assets/a.js", "assets/b.js"];

    const rerun = planRetention({
      record,
      build: "b",
      files: ["assets/b.js"],
      stored,
      now: day(4),
    });

    expect(rerun.upload).toStrictEqual([]);
    expect(rerun.remove).toStrictEqual([]);
    expect(rerun.record.files).toStrictEqual(record.files);

    const rollback = planRetention({
      record,
      build: "a",
      files: ["assets/a.js"],
      stored,
      now: day(4),
    });

    expect(rollback.record.files).toStrictEqual({
      "assets/a.js": null,
      "assets/b.js": at(4),
    });
  });
});

const fakeStore = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  const writes: KvEntry[][] = [];
  const deletes: string[][] = [];

  const kv = {
    getText: (_namespace: string, key: string) =>
      Promise.resolve(values.get(key)),
    listKeys: (_namespace: string, input: { prefix?: string } = {}) =>
      Promise.resolve(
        [...values.keys()].filter((key) => key.startsWith(input.prefix ?? ""))
      ),
    putMany: (_namespace: string, entries: KvEntry[]) => {
      writes.push(entries);

      for (const entry of entries) {
        values.set(entry.key, entry.value);
      }

      return Promise.resolve();
    },
    deleteMany: (_namespace: string, keys: string[]) => {
      deletes.push(keys);

      for (const key of keys) {
        values.delete(key);
      }

      return Promise.resolve();
    },
  };

  // SAFETY: retainBuildAssets only calls the four kv methods this store answers
  return { api: { kv } as never, values, writes, deletes };
};

describe("a build directory and its store", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "retain-assets-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const writeBuild = (files: Record<string, string>) =>
    Promise.all(
      Object.entries(files).map(async ([file, content]) => {
        await mkdir(path.join(directory, file, ".."), { recursive: true });
        await writeFile(path.join(directory, file), content);
      })
    );

  describe(readBuildFiles, () => {
    it("reads a build's files under assets/ and leaves source maps and public files out", async () => {
      await writeBuild({
        "assets/index-1.js": "a",
        "assets/index-1.js.map": "{}",
        "assets/fonts/geist-2.woff2": "f",
        "favicon.ico": "i",
      });
      await expect(readBuildFiles(directory)).resolves.toStrictEqual([
        "assets/fonts/geist-2.woff2",
        "assets/index-1.js",
      ]);
      await expect(
        readBuildFiles(path.join(directory, "missing"))
      ).rejects.toThrow(/No build files/u);
    });
  });

  describe(retainBuildAssets, () => {
    it("uploads new files with their type, removes expired ones and writes the record last", async () => {
      await writeBuild({
        "assets/b.js": "export const b = 1;",
        "assets/b.css": "a{}",
      });

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
      expect(store.writes[0]).toStrictEqual([
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
      expect(store.deletes).toStrictEqual([["assets/old.js"]]);
      expect(store.writes.at(-1)?.map((entry) => entry.key)).toStrictEqual([
        RECORD_KEY,
      ]);
      expect(JSON.parse(store.values.get(RECORD_KEY) ?? "")).toStrictEqual({
        build: "b",
        at: at(8),
        files: {
          "assets/a.js": at(8),
          "assets/b.css": null,
          "assets/b.js": null,
        },
      });
      expect(lines).toStrictEqual([
        "Earlier builds' client files: 2 in this build (2 new), 1 kept from earlier builds, 1 removed.",
      ]);
    });

    it("refuses a record it cannot read rather than treating the store as empty", async () => {
      await writeBuild({ "assets/b.js": "b" });
      const store = fakeStore({ [RECORD_KEY]: '{"files":[]}' });
      await expect(
        retainBuildAssets({
          ...store,
          namespaceId: "ns",
          clientDir: directory,
          build: "b",
        })
      ).rejects.toThrow(/not an asset record/u);
      expect(store.writes).toStrictEqual([]);
    });
  });
});

describe(previousAssetsTarget, () => {
  it("finds the store and build directory in a deploy config", () => {
    const config = {
      account_id: "a".repeat(32),
      assets: { directory: "../client" },
      kv_namespaces: [
        { binding: "KV", id: "1".repeat(32) },
        { binding: "PREVIOUS_ASSETS", id: "2".repeat(32) },
      ],
    };

    expect(
      previousAssetsTarget(config, "/app/dist/server/wrangler.json")
    ).toStrictEqual({
      accountId: "a".repeat(32),
      namespaceId: "2".repeat(32),
      clientDir: "/app/dist/client",
    });
    expect(() =>
      previousAssetsTarget(
        { ...config, kv_namespaces: [] },
        "/app/dist/server/wrangler.json"
      )
    ).toThrow(/binds no PREVIOUS_ASSETS/u);
  });
});
