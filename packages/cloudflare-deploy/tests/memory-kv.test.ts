import { afterEach, expect, test, vi } from "vitest";
import { memoryKv } from "../src/memory-kv.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A KV namespace on a clock the test moves, in seconds. */
function clocked() {
  const clock = { seconds: 1_800_000_000 };
  const kv = memoryKv({ now: () => clock.seconds * 1000 });
  return { kv, clock };
}

test("a write is visible at once where it was made and elsewhere once the cache runs out", async () => {
  const { kv: here, clock } = clocked();
  const there = here.location();

  await here.put("flag", "off");
  expect(await there.get("flag")).toBe("off");
  await here.put("flag", "on");
  expect(await here.get("flag")).toBe("on");
  // `there` keeps what it read for the default 60 seconds.
  clock.seconds += 59;
  expect(await there.get("flag")).toBe("off");
  clock.seconds += 1;
  expect(await there.get("flag")).toBe("on");
  expect(there.operations).toMatchObject({ get: 3, coldReads: 2 });
});

test("a missing key is cached too, and cacheTtl sets how long", async () => {
  const { kv: here, clock } = clocked();
  const there = here.location();

  expect(await there.get("config", { cacheTtl: 300 })).toBeNull();
  await here.put("config", JSON.stringify({ mode: "new" }));
  clock.seconds += 299;
  expect(await there.get("config", { type: "json", cacheTtl: 300 })).toBeNull();
  clock.seconds += 1;
  expect(await there.get<{ mode: string }>("config", { type: "json", cacheTtl: 300 })).toEqual({
    mode: "new",
  });

  await expect(here.get("config", { cacheTtl: 29 })).rejects.toThrow(
    "Cache TTL must be at least 30",
  );
});

test("a delete is visible at once where it was made", async () => {
  const { kv: here } = clocked();
  const there = here.location();
  await here.put("k", "v");
  expect(await there.get("k")).toBe("v");
  await here.delete("k");
  expect(await here.get("k")).toBeNull();
  expect(await there.get("k")).toBe("v");
  expect(here.dump()).toEqual({});
});

test("values come back as text, JSON, bytes or a stream, with their metadata", async () => {
  const { kv } = clocked();
  await kv.put("json", '{"a":1}', { metadata: { owner: "me" } });
  await kv.put("bytes", new Uint8Array([1, 2, 3]));
  await kv.put("stream", new Blob(["streamed"]).stream());

  expect(await kv.get("json", "json")).toEqual({ a: 1 });
  expect(new Uint8Array((await kv.get("bytes", "arrayBuffer")) as ArrayBuffer)).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(await new Response(await kv.get("stream", "stream")).text()).toBe("streamed");
  expect(await kv.getWithMetadata("json")).toEqual({
    value: '{"a":1}',
    metadata: { owner: "me" },
    cacheStatus: null,
  });
  expect(await kv.getWithMetadata("missing")).toEqual({
    value: null,
    metadata: null,
    cacheStatus: null,
  });
});

test("a bulk read answers a map of up to 100 keys, as text or JSON", async () => {
  const { kv } = clocked();
  await kv.put("a", '"one"');
  expect(await kv.get(["a", "b"])).toEqual(
    new Map([
      ["a", '"one"'],
      ["b", null],
    ]),
  );
  expect(await kv.get(["a"], "json")).toEqual(new Map([["a", "one"]]));
  expect(await kv.getWithMetadata(["a"])).toEqual(
    new Map([["a", { value: '"one"', metadata: null, cacheStatus: null }]]),
  );
  const tooMany = Array.from({ length: 101 }, (_, index) => `k${index}`);
  await expect(kv.get(tooMany)).rejects.toThrow("at most 100 keys");
  await expect(kv.get(["a"], { type: "arrayBuffer" } as never)).rejects.toThrow('"text" or "json"');
});

test("keys expire, and an expiry under 60 seconds is refused", async () => {
  const { kv, clock } = clocked();
  await kv.put("session", "s", { expirationTtl: 60 });
  await kv.put("until", "u", { expiration: clock.seconds + 120 });
  expect((await kv.list()).keys).toEqual([
    { name: "session", expiration: clock.seconds + 60 },
    { name: "until", expiration: clock.seconds + 120 },
  ]);

  const there = kv.location();
  expect(await there.get("until")).toBe("u");
  clock.seconds += 60;
  expect(await kv.get("session")).toBeNull();
  clock.seconds += 60;
  // Even a location that cached the value stops serving it once it expired.
  expect(await there.get("until")).toBeNull();
  expect(kv.dump()).toEqual({});

  await expect(kv.put("k", "v", { expirationTtl: 59 })).rejects.toThrow(
    "Expiration TTL must be at least 60",
  );
  await expect(kv.put("k", "v", { expiration: clock.seconds + 30 })).rejects.toThrow(
    "at least 60 seconds in the future",
  );
});

test("list pages through live keys in UTF-8 byte order", async () => {
  const { kv } = clocked();
  // UTF-16 order puts the emoji first; UTF-8 byte order, which KV uses, puts it last.
  for (const key of ["b", "a", "\u{1F600}", "￿", "c/1", "c/2", "c/3"])
    await kv.put(key, "v", key === "a" ? { metadata: { first: true } } : {});

  const first = await kv.list({ limit: 4 });
  expect(first.keys).toEqual([
    { name: "a", metadata: { first: true } },
    { name: "b" },
    { name: "c/1" },
    { name: "c/2" },
  ]);
  expect(first.list_complete).toBe(false);
  const cursor = first.list_complete ? undefined : first.cursor;
  const second = await kv.list({ limit: 4, cursor });
  expect(second.keys.map((key) => key.name)).toEqual(["c/3", "￿", "\u{1F600}"]);
  expect(second.list_complete).toBe(true);

  expect((await kv.list({ prefix: "c/" })).keys.map((key) => key.name)).toEqual([
    "c/1",
    "c/2",
    "c/3",
  ]);
  await expect(kv.list({ limit: 1001 })).rejects.toThrow("from 1 to 1000");
});

test("keys, values and metadata are held to KV's limits", async () => {
  const { kv } = clocked();
  await kv.put("k".repeat(512), "fits");
  await expect(kv.put("k".repeat(513), "v")).rejects.toThrow(
    "414 UTF-8 encoded length of 513 exceeds key length limit of 512",
  );
  await expect(kv.get("é".repeat(257))).rejects.toThrow("length of 514");
  await expect(kv.put("", "v")).rejects.toThrow("must not be empty");
  await expect(kv.put("..", "v")).rejects.toThrow('Illegal key name ".."');
  await expect(kv.put("k", "v", { metadata: { pad: "x".repeat(1020) } })).rejects.toThrow(
    "413 Metadata length of 1030 exceeds limit of 1024",
  );
  await expect(kv.put("k", new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toThrow(
    "413 Value length of 26214401 exceeds limit of 26214400",
  );
});

test("failPuts makes the next puts in any location fail as a rate limit does", async () => {
  const { kv } = clocked();
  kv.failPuts(2);
  await expect(kv.put("k", "1")).rejects.toThrow("KV PUT failed: 429 Too Many Requests");
  await expect(kv.location().put("k", "2")).rejects.toThrow("429");
  await kv.put("k", "3");
  expect(kv.dump()).toEqual({ k: "3" });
  expect(kv.operations.put).toBe(2);
});

test("without a clock it follows Date.now, so fake timers move it", async () => {
  vi.useFakeTimers();
  const here = memoryKv();
  const there = here.location();
  expect(await there.get("k")).toBeNull();
  await here.put("k", "v");
  vi.advanceTimersByTime(60_000);
  expect(await there.get("k")).toBe("v");
});
