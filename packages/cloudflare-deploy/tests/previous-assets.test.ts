import { expect, test } from "vitest";
import {
  type PreviousAssetStore,
  isAssetRequest,
  servePreviousAsset,
} from "../src/previous-assets.js";

function store(entries: Record<string, { bytes: string; contentType: string }>) {
  const reads: string[] = [];
  const kv: PreviousAssetStore = {
    async getWithMetadata(key) {
      reads.push(key);
      const entry = entries[key];
      return entry
        ? {
            value: new TextEncoder().encode(entry.bytes).buffer as ArrayBuffer,
            metadata: { contentType: entry.contentType },
          }
        : { value: null, metadata: null };
    },
  };
  return { kv, reads };
}

test("only reads of paths under /assets/ go to the store", () => {
  expect(isAssetRequest(new Request("https://x.test/assets/index-1.js"))).toBe(true);
  expect(isAssetRequest(new Request("https://x.test/assets/a.js", { method: "HEAD" }))).toBe(true);
  expect(isAssetRequest(new Request("https://x.test/assets/a.js", { method: "POST" }))).toBe(false);
  expect(isAssetRequest(new Request("https://x.test/assets"))).toBe(false);
  expect(isAssetRequest(new Request("https://x.test/api/media/assets/1"))).toBe(false);
});

test("serves an earlier build's file with its type, cached as immutable", async () => {
  const { kv, reads } = store({
    "assets/route-1.js": { bytes: "export {}", contentType: "text/javascript; charset=utf-8" },
  });
  const response = await servePreviousAsset(new Request("https://x.test/assets/route-1.js"), kv);
  expect(reads).toEqual(["assets/route-1.js"]);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await response.text()).toBe("export {}");

  const head = await servePreviousAsset(
    new Request("https://x.test/assets/route-1.js", { method: "HEAD" }),
    kv,
  );
  expect(head.status).toBe(200);
  expect(head.body).toBeNull();
});

test("a file no build has, or a Worker without a store, is a 404 nobody caches", async () => {
  const { kv } = store({});
  for (const answer of [
    await servePreviousAsset(new Request("https://x.test/assets/gone-1.js"), kv),
    await servePreviousAsset(new Request("https://x.test/assets/gone-1.js"), undefined),
  ]) {
    expect(answer.status).toBe(404);
    expect(answer.headers.get("cache-control")).toBe("no-store");
  }
});

test("a key longer than KV allows is a 404 without a read", async () => {
  const { kv, reads } = store({});
  const response = await servePreviousAsset(
    new Request(`https://x.test/assets/${"a".repeat(600)}.js`),
    kv,
  );
  expect(response.status).toBe(404);
  expect(reads).toEqual([]);
});
