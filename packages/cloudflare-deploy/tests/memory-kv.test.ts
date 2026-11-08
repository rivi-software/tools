import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryKv } from "../src/memory-kv.js";

/** A KV namespace on a clock the test moves, in seconds. */
const clocked = () => {
  const clock = { seconds: 1_800_000_000 };
  const kv = memoryKv({ now: () => clock.seconds * 1000 });

  return { kv, clock };
};

describe(memoryKv, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a write is visible at once where it was made and elsewhere once the cache runs out", async () => {
    const { kv: here, clock } = clocked();
    const there = here.location();

    await here.put("flag", "off");
    await expect(there.get("flag")).resolves.toBe("off");
    await here.put("flag", "on");
    await expect(here.get("flag")).resolves.toBe("on");
    // `there` keeps what it read for the default 60 seconds.
    clock.seconds += 59;
    await expect(there.get("flag")).resolves.toBe("off");
    clock.seconds += 1;
    await expect(there.get("flag")).resolves.toBe("on");
    expect(there.operations).toMatchObject({ get: 3, coldReads: 2 });
  });

  it("a missing key is cached too, and cacheTtl sets how long", async () => {
    const { kv: here, clock } = clocked();
    const there = here.location();

    await expect(there.get("config", { cacheTtl: 300 })).resolves.toBeNull();
    await here.put("config", JSON.stringify({ mode: "new" }));
    clock.seconds += 299;
    await expect(
      there.get("config", { type: "json", cacheTtl: 300 })
    ).resolves.toBeNull();
    clock.seconds += 1;
    await expect(
      there.get<{ mode: string }>("config", { type: "json", cacheTtl: 300 })
    ).resolves.toStrictEqual({
      mode: "new",
    });

    await expect(here.get("config", { cacheTtl: 29 })).rejects.toThrow(
      "Cache TTL must be at least 30"
    );
  });

  it("a delete is visible at once where it was made", async () => {
    const { kv: here } = clocked();
    const there = here.location();
    await here.put("k", "v");
    await expect(there.get("k")).resolves.toBe("v");
    await here.delete("k");
    await expect(here.get("k")).resolves.toBeNull();
    await expect(there.get("k")).resolves.toBe("v");
    expect(here.dump()).toStrictEqual({});
  });

  it("values come back as text, JSON, bytes or a stream, with their metadata", async () => {
    const { kv } = clocked();
    await kv.put("json", '{"a":1}', { metadata: { owner: "me" } });
    await kv.put("bytes", new Uint8Array([1, 2, 3]));
    await kv.put("stream", new Blob(["streamed"]).stream());

    await expect(kv.get("json", "json")).resolves.toStrictEqual({ a: 1 });
    // SAFETY: the "arrayBuffer" overload answers an ArrayBuffer for a key that exists
    const bytes = (await kv.get("bytes", "arrayBuffer")) as ArrayBuffer;
    expect(new Uint8Array(bytes)).toStrictEqual(new Uint8Array([1, 2, 3]));
    await expect(
      new Response(await kv.get("stream", "stream")).text()
    ).resolves.toBe("streamed");
    await expect(kv.getWithMetadata("json")).resolves.toStrictEqual({
      value: '{"a":1}',
      metadata: { owner: "me" },
      cacheStatus: null,
    });
    await expect(kv.getWithMetadata("missing")).resolves.toStrictEqual({
      value: null,
      metadata: null,
      cacheStatus: null,
    });
  });

  it("a bulk read answers a map of up to 100 keys, as text or JSON", async () => {
    const { kv } = clocked();
    await kv.put("a", '"one"');
    await expect(kv.get(["a", "b"])).resolves.toStrictEqual(
      new Map([
        ["a", '"one"'],
        ["b", null],
      ])
    );
    await expect(kv.get(["a"], "json")).resolves.toStrictEqual(
      new Map([["a", "one"]])
    );
    await expect(kv.getWithMetadata(["a"])).resolves.toStrictEqual(
      new Map([["a", { value: '"one"', metadata: null, cacheStatus: null }]])
    );
    const tooMany = Array.from({ length: 101 }, (_, index) => `k${index}`);
    await expect(kv.get(tooMany)).rejects.toThrow("at most 100 keys");
    // SAFETY: a JavaScript caller can ask for a type a bulk read does not answer, as this does
    await expect(
      kv.get(["a"], { type: "arrayBuffer" } as never)
    ).rejects.toThrow('"text" or "json"');
  });

  it("keys expire, and an expired key stops being served everywhere", async () => {
    const { kv, clock } = clocked();
    await kv.put("session", "s", { expirationTtl: 60 });
    await kv.put("until", "u", { expiration: clock.seconds + 120 });
    const listed = await kv.list();
    expect(listed.keys).toStrictEqual([
      { name: "session", expiration: clock.seconds + 60 },
      { name: "until", expiration: clock.seconds + 120 },
    ]);

    const there = kv.location();
    await expect(there.get("until")).resolves.toBe("u");
    clock.seconds += 60;
    await expect(kv.get("session")).resolves.toBeNull();
    clock.seconds += 60;
    // Even a location that cached the value stops serving it once it expired.
    await expect(there.get("until")).resolves.toBeNull();
    expect(kv.dump()).toStrictEqual({});
  });

  it("refuses an expiry under 60 seconds away", async () => {
    const { kv, clock } = clocked();
    await expect(kv.put("k", "v", { expirationTtl: 59 })).rejects.toThrow(
      "Expiration TTL must be at least 60"
    );
    await expect(
      kv.put("k", "v", { expiration: clock.seconds + 30 })
    ).rejects.toThrow("at least 60 seconds in the future");
  });

  it("list pages through live keys in UTF-8 byte order", async () => {
    const { kv } = clocked();

    // UTF-16 order puts the emoji first; UTF-8 byte order, which KV uses, puts it last.
    for (const key of ["b", "a", "\u{1F600}", "￿", "c/1", "c/2", "c/3"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the keys go in one at a time, as a Worker writes them
      await kv.put(key, "v", key === "a" ? { metadata: { first: true } } : {});
    }

    const first = await kv.list({ limit: 4 });
    expect(first.keys).toStrictEqual([
      { name: "a", metadata: { first: true } },
      { name: "b" },
      { name: "c/1" },
      { name: "c/2" },
    ]);
    expect(first.list_complete).toBeFalsy();
    const cursor = first.list_complete ? undefined : first.cursor;
    const second = await kv.list({ limit: 4, cursor });
    expect(second.keys.map((key) => key.name)).toStrictEqual([
      "c/3",
      "￿",
      "\u{1F600}",
    ]);
    expect(second.list_complete).toBeTruthy();
  });

  it("lists only the keys under a prefix, and refuses a limit over 1000", async () => {
    const { kv } = clocked();

    for (const key of ["a", "c/1", "c/2", "c/3"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the keys go in one at a time, as a Worker writes them
      await kv.put(key, "v");
    }

    const prefixed = await kv.list({ prefix: "c/" });
    expect(prefixed.keys.map((key) => key.name)).toStrictEqual([
      "c/1",
      "c/2",
      "c/3",
    ]);
    await expect(kv.list({ limit: 1001 })).rejects.toThrow("from 1 to 1000");
  });

  it("holds keys to KV's length limits", async () => {
    const { kv } = clocked();
    await kv.put("k".repeat(512), "fits");
    await expect(kv.put("k".repeat(513), "v")).rejects.toThrow(
      "414 UTF-8 encoded length of 513 exceeds key length limit of 512"
    );
    await expect(kv.get("é".repeat(257))).rejects.toThrow("length of 514");
    await expect(kv.put("", "v")).rejects.toThrow("must not be empty");
    await expect(kv.put("..", "v")).rejects.toThrow('Illegal key name ".."');
  });

  it("holds values and metadata to KV's size limits", async () => {
    const { kv } = clocked();
    await expect(
      kv.put("k", "v", { metadata: { pad: "x".repeat(1020) } })
    ).rejects.toThrow("413 Metadata length of 1030 exceeds limit of 1024");
    await expect(
      kv.put("k", new Uint8Array(25 * 1024 * 1024 + 1))
    ).rejects.toThrow("413 Value length of 26214401 exceeds limit of 26214400");
  });

  it("failPuts makes the next puts in any location fail as a rate limit does", async () => {
    const { kv } = clocked();
    kv.failPuts(2);
    await expect(kv.put("k", "1")).rejects.toThrow(
      "KV PUT failed: 429 Too Many Requests"
    );
    await expect(kv.location().put("k", "2")).rejects.toThrow("429");
    await kv.put("k", "3");
    expect(kv.dump()).toStrictEqual({ k: "3" });
    expect(kv.operations.put).toBe(2);
  });

  it("without a clock it follows Date.now, so fake timers move it", async () => {
    vi.useFakeTimers();
    const here = memoryKv();
    const there = here.location();
    await expect(there.get("k")).resolves.toBeNull();
    await here.put("k", "v");
    vi.advanceTimersByTime(60_000);
    await expect(there.get("k")).resolves.toBe("v");
  });
});
