import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { request } from "./registry-request.ts";

const URL = "https://registry.example/@rivi-software%2fx";

/** Tries that have 50 milliseconds to answer, with no wait before a retry. */
const FAST = { retryMs: 0, timeoutMs: 50 };

/** A fetch that answers each try with the next of `answers`: a status, or an error it throws. */
const answering = (...answers: (number | Error)[]) => {
  const next = answers.values();

  return vi.fn<typeof fetch>(() => {
    const answer = next.next().value;

    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(new Response(`status ${answer}`, { status: answer }));
  });
};

/** A busy or failing answer with a Retry-After header. */
const busy = (status: number, retryAfter: string) =>
  new Response("", { headers: { "retry-after": retryAfter }, status });

/** A fetch that never answers, and rejects as fetch does when its request is aborted. */
const silent = () =>
  vi.fn<typeof fetch>(async (_url, init) => {
    // SAFETY: request gives each try a signal, its deadline.
    const signal = init?.signal as AbortSignal;

    await once(signal, "abort");

    throw signal.reason;
  });

/** An answer whose body sends its first bytes and then nothing, until its request is aborted. */
const stalling: typeof fetch = (_url, init) =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"name":'));
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal?.reason)
          );
        },
      })
    )
  );

describe(request, () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockReturnValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the first answer, its body read in full", async () => {
    const fetchImpl = answering(200);

    const answer = await request(URL, {
      ...FAST,
      fetchImpl,
      headers: { accept: "application/json" },
    });

    expect(answer).toStrictEqual({
      body: Buffer.from("status 200"),
      ok: true,
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]?.headers).toStrictEqual({
      accept: "application/json",
    });
  });

  it("returns a 404 without trying again", async () => {
    const fetchImpl = answering(404);

    await expect(request(URL, { ...FAST, fetchImpl })).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("tries a busy or failing registry again, and says so", async () => {
    const fetchImpl = answering(503, 429, 200);

    await expect(request(URL, { ...FAST, fetchImpl })).resolves.toMatchObject({
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenCalledWith(
      `${URL} answered 503: trying again in 0 seconds`
    );
  });

  it("waits as long as a busy answer's Retry-After asks, up to its cap", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(busy(429, "1"))
      .mockResolvedValueOnce(
        busy(503, new Date(Date.now() + 60_000).toUTCString())
      )
      .mockResolvedValueOnce(new Response("{}"));

    await expect(
      request(URL, { ...FAST, fetchImpl, maxWaitMs: 10, retryMs: 1 })
    ).resolves.toMatchObject({ status: 200 });
    expect(console.log).toHaveBeenNthCalledWith(
      1,
      `${URL} answered 429: trying again in 0.01 seconds`
    );
    expect(console.log).toHaveBeenNthCalledWith(
      2,
      `${URL} answered 503: trying again in 0.01 seconds`
    );
  });

  it("returns the third 5xx, after three tries", async () => {
    const fetchImpl = answering(502, 503, 500);

    await expect(request(URL, { ...FAST, fetchImpl })).resolves.toMatchObject({
      body: Buffer.from("status 500"),
      ok: false,
      status: 500,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up on a registry that does not answer, after three tries", async () => {
    const fetchImpl = silent();

    await expect(request(URL, { ...FAST, fetchImpl })).rejects.toThrow(
      `${URL} gave no full answer within 0.05 seconds, on each of 3 tries`
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("times out a body that stops partway, and tries again", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>(stalling)
      .mockImplementationOnce(stalling)
      .mockResolvedValueOnce(new Response("{}"));

    await expect(request(URL, { ...FAST, fetchImpl })).resolves.toStrictEqual({
      body: Buffer.from("{}"),
      ok: true,
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledWith(
      `${URL} gave no full answer within 0.05 seconds: trying again in 0 seconds`
    );
  });

  it("tries again when the registry cannot be reached, and names why", async () => {
    const unreachable = new TypeError("fetch failed", {
      cause: new Error("getaddrinfo ENOTFOUND registry.example"),
    });

    const fetchImpl = answering(unreachable, unreachable, unreachable);

    await expect(request(URL, { ...FAST, fetchImpl })).rejects.toThrow(
      `${URL} fetch failed: getaddrinfo ENOTFOUND registry.example, on each of 3 tries`
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
