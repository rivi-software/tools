# @rivi-software/workers-coordination

[![npm version](https://img.shields.io/npm/v/@rivi-software/workers-coordination?label=npm&color=0b6b3a)](https://www.npmjs.com/package/@rivi-software/workers-coordination) [![CI status](https://img.shields.io/github/actions/workflow/status/rivi-software/tools/ci.yml?branch=main&label=CI)](https://github.com/rivi-software/tools/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-0b6b3a)](LICENSE)

Two Durable Objects for Cloudflare Workers, each with a typed client:

- **A rate limit** with one count for each key, wherever its requests come from, and a window of any length: "5 sign-in attempts per account per 15 minutes". `rateLimit()` answers `{ allowed, remaining, resetAt }`, and the object deletes a window once it ends, so storage does not grow.
- **A lease lock** that one caller holds at a time: one provisioning run or one backfill per customer, across every Worker. A lease expires on its own, so a holder that crashed cannot block the others, and only the holder's token renews or releases it.

Both need one place that sees every request for a key, which is what a Durable Object is. The alternatives fall short for these two jobs. The [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) counts in 10- or 60-second periods, and in each Cloudflare location apart, so a caller spread across locations gets an allowance in each. [WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) count per IP at the edge, not per account or other key of the app. KV is eventually consistent: simultaneous requests can all read the same count, and two callers can both see a lock as free.

## Install

```bash
npm install @rivi-software/workers-coordination
```

The objects need the SQLite storage backend, which every new Durable Object class gets, on the Free plan as on the Paid one. The package is ESM only and has no dependencies. Its clients take the namespace bindings that `wrangler types` declares for the two classes, and a binding of another class does not type-check.

## Usage

### Export and bind the classes

The Worker's main module exports the classes:

```ts
// src/index.ts
export { LeaseLock, RateLimiter } from "@rivi-software/workers-coordination";
```

The Wrangler config binds them and declares them as Durable Object classes. A new Worker declares them in `exports`:

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "RATE_LIMITER", "class_name": "RateLimiter" },
      { "name": "LOCKS", "class_name": "LeaseLock" },
    ],
  },
  "exports": {
    "RateLimiter": { "type": "durable-object", "storage": "sqlite" },
    "LeaseLock": { "type": "durable-object", "storage": "sqlite" },
  },
}
```

A Worker that already uses the `migrations` array adds a migration with a new tag instead. A Worker uses one of the two, not both:

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "RATE_LIMITER", "class_name": "RateLimiter" },
      { "name": "LOCKS", "class_name": "LeaseLock" },
    ],
  },
  "migrations": [
    // …the Worker's earlier migrations
    { "tag": "v2", "new_sqlite_classes": ["RateLimiter", "LeaseLock"] },
  ],
}
```

Then `npx wrangler types` adds `RATE_LIMITER: DurableObjectNamespace<RateLimiter>` and `LOCKS: DurableObjectNamespace<LeaseLock>` to `Env`. A Worker needs only the class it uses. To give a class another name, such as when the Worker has a `RateLimiter` of its own, export it under that name and use the name in both places: `export { RateLimiter as AccountRateLimiter }` and `"class_name": "AccountRateLimiter"`. See Cloudflare's [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) for renaming or deleting a class later.

### Rate limit

```ts
import { rateLimit, resetRateLimit } from "@rivi-software/workers-coordination";

const key = `sign-in:${accountId}`;
const result = await rateLimit(env.RATE_LIMITER, key, { limit: 5, windowSeconds: 15 * 60 });
if (!result.allowed) {
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return new Response("Too many attempts", {
    status: 429,
    headers: { "Retry-After": String(retryAfter) },
  });
}

const signedIn = await checkPassword(accountId, password);
// A sign-in that succeeded does not count against the account.
if (signedIn) await resetRateLimit(env.RATE_LIMITER, key);
```

`result` is `{ allowed, remaining, resetAt }`: whether this request is within the limit, how many more the window allows, and when the window ends, in milliseconds since the epoch. A refused request is not counted.

The key is any non-empty string. Every use of one class shares its keys, so a key starts with what it limits, such as `sign-in:` or `password-reset:`, and two limits on the same account do not share a count.

### Lease lock

```ts
import { acquireLease } from "@rivi-software/workers-coordination";

const lease = await acquireLease(env.LOCKS, `provision:${customerId}`, { ttlMs: 60_000 });
if (!lease) return new Response("Provisioning is already running", { status: 409 });
try {
  for (const step of provisioningSteps(customerId)) {
    await step.run();
    await lease.renew(); // another 60 seconds from now
  }
} finally {
  await lease.release();
}
```

`acquireLease` answers `null` at once while another caller holds the key; it does not wait. A `Lease` has its `key`, its `token` and its `expiresAt`, which `renew()` moves on.

- `renew()` extends the lease by its `ttlMs` from now. When the lease has already ended, it expired or was released, `renew()` throws a `LeaseLostError` and leaves the key as it is: another caller may hold it by then, so the work should stop.
- `release()` ends the lease and answers `true`. It answers `false` when the lease had already ended, and then it does not touch the key, since that may be the next holder's lease.

## How it works

Each key has its own object: the client calls `namespace.get(namespace.idFromName(key))`, so every request for a key reaches the same object, wherever the Worker runs. An object runs one call at a time against its own storage, and reads and writes its state with the synchronous storage API inside that call. Simultaneous requests are therefore counted, or granted the lease, one after the other, never both on the same state. The clients get a new stub for each call, since a stub that saw an error can stay broken.

**The rate limit's window.** A window opens at a key's first request and lasts `windowSeconds`; it is not aligned to the clock. The object stores the window's count and end. A request before the end counts while the count is below `limit`, and is refused otherwise; a refused request is not counted, so the count never passes the limit. The first request at or after the end opens a new window. A window keeps the end it opened with: a changed `windowSeconds` applies from the next window, and a changed `limit` at once.

**The lease.** The object grants a lease when it holds none, or when the one it holds has reached its `expiresAt`. It makes the lease's token itself (`crypto.randomUUID()`) and hands it to the holder only. Renewing or releasing takes that token and works only while the lease runs, so a holder whose lease expired can neither extend nor end the next holder's.

**Storage.** An object stores one entry, its window or its lease, and sets an alarm for when it ends. The alarm deletes the object's storage with `deleteAll()`, and so do `resetRateLimit` and `release()`. An object whose storage is empty stops existing once it shuts down, so a key with no window or lease costs no storage. From compatibility date 2026-02-24 on, `deleteAll()` deletes the alarm as well; the objects call `deleteAlarm()` first, which covers earlier dates.

## Limits

- **Fixed windows.** A fixed window lets through up to twice the limit in a span shorter than one window: `limit` requests just before a window ends, and `limit` more just after. A window that opens at the key's first request makes that harder to time, but does not prevent it.
- **A round trip for each call.** A Durable Object runs in one place, near where it was first used, and each call waits for the round trip to it. A Worker that calls `rateLimit` on every request adds that wait to every request.
- **One object for each key.** An object handles about 500 to 1,000 calls a second before Cloudflare reports it as overloaded. That is per key: a limit on one global key, such as all sign-ins together, meets it first.
- **A lease is a time, not a guarantee.** A holder that keeps working past its `expiresAt` without renewing can overlap the next holder, for example after a long pause. Pick a `ttlMs` longer than the longest step between renewals, renew between steps, and stop when `renew()` throws.
- **No waiting, no re-entry.** `acquireLease` answers `null` rather than queuing, and a caller that holds a lease and asks again gets `null` too.
- **Clocks.** `resetAt` and `expiresAt` come from the object's clock, and a Worker elsewhere reads its own, so a `Retry-After` computed from them can be off by the difference between the two.
- **SQLite storage only.** A class created with the key-value storage backend (`new_classes`, or `"storage": "legacy-kv"`) cannot run these objects, which use the synchronous storage API.
- **Cost.** Each call is a Durable Object request, and the storage it uses is billed in rows. A counted request writes one row, and two when it opens a window: the window and its alarm. Taking or renewing a lease writes two. Emptying an object, at its alarm or on a reset or release, writes too. A refused request only reads.

## Exports

From `@rivi-software/workers-coordination`:

| Export | What |
| --- | --- |
| `RateLimiter` | The Durable Object class behind `rateLimit`, one object for each key. The Worker exports it and binds it ([Usage](#export-and-bind-the-classes)). |
| `rateLimit(namespace, key, { limit, windowSeconds })` | Counts one request for `key` and answers `RateLimitResult`: `{ allowed, remaining, resetAt }`. Throws a `RangeError` for a `limit` that is not a whole number of 1 or more, or a `windowSeconds` that is not above 0, and a `TypeError` for an empty key. |
| `resetRateLimit(namespace, key)` | Forgets `key`'s count, so its next request opens a new window. |
| `LeaseLock` | The Durable Object class behind `acquireLease`, one object for each key. |
| `acquireLease(namespace, key, { ttlMs })` | Takes the lease on `key` for `ttlMs` milliseconds and answers a `Lease`, or `null` while another caller holds it. Throws a `RangeError` for a `ttlMs` that is not a whole number of 1 or more, and a `TypeError` for an empty key. |
| `Lease` | `key`, `token`, `expiresAt`, `renew()` and `release()` ([Lease lock](#lease-lock)). |
| `LeaseLostError` | What `renew()` throws when the lease has ended: `name` is `"LeaseLostError"` and `key` is the lease's key. |
| Types | `RateLimitOptions`, `RateLimitResult`, `LeaseOptions`, `LeaseGrant`, and `RateLimiterStub`, `LeaseLockStub` and `DurableObjectNamespaceLike`: the parts of a namespace binding the clients call, which `DurableObjectNamespace<RateLimiter>` and `DurableObjectNamespace<LeaseLock>` have. |

The objects' own methods are Durable Object RPC methods, for a Worker that calls a stub itself: `RateLimiter` has `consume(options)` and `reset()`, and `LeaseLock` has `acquire(options)`, `renew(token)` and `release(token)`.

## Development

The tests in `tests/` cover the window and lease arithmetic at exact times and the clients' checks before they call an object, in Node (`rate-limit.test.ts`, `lease.test.ts`). `workerd.test.ts` builds the package and runs it in workerd through Miniflare, with a Worker (`tests/fixtures/worker.js`) that exports the classes and calls the clients: simultaneous requests and lease requests for one key, the alarms that empty storage when a window or lease ends, a holder that never released, and the alarm's deletion before compatibility date 2026-02-24. `tests/types` type-checks a Worker that uses the package against `@cloudflare/workers-types`, as an app's would be. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 RIVI Software.

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>Part of <a href="https://github.com/rivi-software/tools#readme">RIVI tools</a>, the packages <a href="https://rivi.software">RIVI Software</a> builds its own apps with.</sub>
</p>
