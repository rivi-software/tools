import { describe, expect, it } from "vitest";

import { isAssetRequest, servePreviousAsset } from "../src/previous-assets.js";
import type { PreviousAssetStore } from "../src/previous-assets.js";

const store = (
  entries: Record<string, { bytes: string; contentType: string }>
) => {
  const reads: string[] = [];

  const kv: PreviousAssetStore = {
    getWithMetadata: (key) => {
      reads.push(key);
      const entry = entries[key];

      if (!entry) {
        return Promise.resolve({ value: null, metadata: null });
      }

      // SAFETY: TextEncoder answers a Uint8Array over its own ArrayBuffer, never a shared one
      const value = new TextEncoder().encode(entry.bytes).buffer as ArrayBuffer;

      return Promise.resolve({
        value,
        metadata: { contentType: entry.contentType },
      });
    },
  };

  return { kv, reads };
};

describe(isAssetRequest, () => {
  it("only reads of paths under /assets/ go to the store", () => {
    expect(
      isAssetRequest(new Request("https://x.test/assets/index-1.js"))
    ).toBeTruthy();
    expect(
      isAssetRequest(
        new Request("https://x.test/assets/a.js", { method: "HEAD" })
      )
    ).toBeTruthy();
    expect(
      isAssetRequest(
        new Request("https://x.test/assets/a.js", { method: "POST" })
      )
    ).toBeFalsy();
    expect(isAssetRequest(new Request("https://x.test/assets"))).toBeFalsy();
    expect(
      isAssetRequest(new Request("https://x.test/api/media/assets/1"))
    ).toBeFalsy();
  });
});

describe(servePreviousAsset, () => {
  it("serves an earlier build's file with its type, cached as immutable", async () => {
    const { kv, reads } = store({
      "assets/route-1.js": {
        bytes: "export {}",
        contentType: "text/javascript; charset=utf-8",
      },
    });

    const response = await servePreviousAsset(
      new Request("https://x.test/assets/route-1.js"),
      kv
    );

    expect(reads).toStrictEqual(["assets/route-1.js"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    await expect(response.text()).resolves.toBe("export {}");
  });

  it("answers a HEAD of a stored file without a body", async () => {
    const { kv } = store({
      "assets/route-1.js": {
        bytes: "export {}",
        contentType: "text/javascript; charset=utf-8",
      },
    });

    const head = await servePreviousAsset(
      new Request("https://x.test/assets/route-1.js", { method: "HEAD" }),
      kv
    );

    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  it("finds a file whose name the request percent-encodes", async () => {
    const { kv, reads } = store({
      "assets/Über page-1.js": {
        bytes: "export {}",
        contentType: "text/javascript; charset=utf-8",
      },
    });

    const response = await servePreviousAsset(
      new Request("https://x.test/assets/%C3%9Cber%20page-1.js"),
      kv
    );

    expect(reads).toStrictEqual(["assets/Über page-1.js"]);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("export {}");
  });

  it("answers a malformed escape with a 404, without reading the store", async () => {
    const { kv, reads } = store({});

    const malformed = await servePreviousAsset(
      new Request("https://x.test/assets/%E0%A4%A.js"),
      kv
    );

    expect(malformed.status).toBe(404);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    expect(reads).toHaveLength(0);
  });

  it("a file no build has, or a Worker without a store, is a 404 nobody caches", async () => {
    const { kv } = store({});

    for (const answer of [
      await servePreviousAsset(
        new Request("https://x.test/assets/gone-1.js"),
        kv
      ),
      await servePreviousAsset(
        new Request("https://x.test/assets/gone-1.js"),
        undefined
      ),
    ]) {
      expect(answer.status).toBe(404);
      expect(answer.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("a key longer than KV allows is a 404 without a read", async () => {
    const { kv, reads } = store({});

    const response = await servePreviousAsset(
      new Request(`https://x.test/assets/${"a".repeat(600)}.js`),
      kv
    );

    expect(response.status).toBe(404);
    expect(reads).toStrictEqual([]);
  });
});
