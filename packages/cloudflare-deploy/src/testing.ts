/**
 * Test doubles for code built on this package: `createFakeCloudflareApi()`, an in-memory Cloudflare
 * REST API to hand `cloudflareApi` as its transport, and `memoryKv()`, a KV namespace whose
 * locations each cache what they read, so a test sees the stale reads production would.
 */
export {
  createFakeCloudflareApi,
  type FakeCloudflareApi,
  type FakeCloudflareApiOptions,
  type FakeD1Database,
  type FakeFailure,
  type FakeKvNamespace,
  type FakeKvValue,
  type FakeR2Bucket,
  type FakeScript,
  type FakeScriptModule,
} from "./fake-cloudflare-api.js";
export {
  MemoryKv,
  memoryKv,
  type KvListKey,
  type KvListOptions,
  type KvListResult,
  type KvOperations,
  type KvPutOptions,
  type KvReadOptions,
  type KvValueType,
  type KvValueWithMetadata,
  type MemoryKvOptions,
} from "./memory-kv.js";
