import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { CloudflareApi, KvEntry } from "./cloudflare-api.js";
import { type Env, requireCloudflareAccountId } from "./deploy-env.js";
import {
  ASSET_PATH_PREFIX,
  PREVIOUS_ASSETS_BINDING,
  type PreviousAssetMetadata,
  assetKey,
} from "./previous-assets.js";

/**
 * The deploy half of skew protection (./previous-assets.ts): before a Worker version
 * goes live, its build's hashed client files go into the app's KV store, so they can still be
 * served once a later deploy has replaced them. A file stays until `RETAIN_DAYS` after the first
 * deploy without it went live; then the deploy removes it.
 */

/** How long a tab on a superseded build can still load that build's files. */
export const RETAIN_DAYS = 7;

/**
 * The store's record of its files: each key with the time the first deploy without it went live,
 * or `null` while the live build has it.
 */
export const RECORD_KEY = "record";

export type AssetRecord = {
  /** The build the last deploy put live, for a person reading the store. */
  build: string;
  at: string;
  files: Record<string, string | null>;
};

export type RetentionPlan = {
  record: AssetRecord;
  /** The build's files the store does not hold yet. */
  upload: string[];
  /** Stored files no tab needs any more. */
  remove: string[];
};

const DAY_MS = 86_400_000;

/**
 * What the store holds after this deploy. A file of the build is live; a file that was live
 * stops being live now; a stored file the record does not know (the first deploy, a lost record,
 * a deploy that stopped before recording) counts from now too, so nothing a tab may need is
 * removed early. Content-hashed names give a key the same bytes in every build that has it.
 */
export function planRetention(input: {
  record: AssetRecord | null;
  build: string;
  files: string[];
  stored: string[];
  now: Date;
  retainDays?: number;
}): RetentionPlan {
  const at = input.now.toISOString();
  const cutoff = input.now.getTime() - (input.retainDays ?? RETAIN_DAYS) * DAY_MS;
  const live = new Set(input.files);
  const known = input.record?.files ?? {};
  const files: Record<string, string | null> = {};
  for (const key of new Set([...Object.keys(known), ...input.stored, ...input.files])) {
    if (live.has(key)) files[key] = null;
    else {
      const since = known[key] ?? at;
      if (Date.parse(since) > cutoff) files[key] = since;
    }
  }
  const stored = new Set(input.stored);
  return {
    record: { build: input.build, at, files },
    upload: input.files.filter((key) => !stored.has(key)),
    remove: input.stored.filter((key) => !(key in files)),
  };
}

export function parseAssetRecord(text: string): AssetRecord {
  const value: unknown = JSON.parse(text);
  const record = value as AssetRecord;
  const valid =
    typeof value === "object" &&
    value !== null &&
    typeof record.build === "string" &&
    typeof record.at === "string" &&
    typeof record.files === "object" &&
    record.files !== null &&
    Object.values(record.files).every(
      (since) => since === null || (typeof since === "string" && !Number.isNaN(Date.parse(since))),
    );
  if (!valid) throw new Error(`The store's ${RECORD_KEY} is not an asset record`);
  return record;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

export const contentTypeOf = (key: string) =>
  CONTENT_TYPES[extname(key).toLowerCase()] ?? "application/octet-stream";

/**
 * The store keys of a build's files: everything under `<clientDir>/assets/` except source maps,
 * which are never served.
 */
export async function readBuildFiles(clientDir: string) {
  const root = join(clientDir, ASSET_PATH_PREFIX);
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`No build files in ${root}`);
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".map"))
    .map((entry) => {
      const path = relative(clientDir, join(entry.parentPath, entry.name));
      return assetKey(`/${path.split(sep).join("/")}`);
    })
    .sort();
}

/** The parts of a Wrangler deploy config (`dist/server/wrangler.json`) the store is found by. */
export type AssetDeployConfig = {
  account_id?: string;
  assets?: { directory?: string };
  kv_namespaces?: { binding: string; id?: string }[];
};

/**
 * The account, store and build directory of a deploy config, whose `assets.directory` is relative
 * to the config file. Refuses a config without the `PREVIOUS_ASSETS` namespace or static assets.
 */
export function previousAssetsTarget(
  config: AssetDeployConfig,
  configPath: string,
  env: Env = process.env,
) {
  const namespaceId = config.kv_namespaces?.find(
    (entry) => entry.binding === PREVIOUS_ASSETS_BINDING,
  )?.id;
  if (!namespaceId)
    throw new Error(`${configPath} binds no ${PREVIOUS_ASSETS_BINDING} KV namespace by id`);
  if (!config.assets?.directory) throw new Error(`${configPath} serves no static assets`);
  return {
    accountId: config.account_id ?? requireCloudflareAccountId(env),
    namespaceId,
    clientDir: resolve(dirname(configPath), config.assets.directory),
  };
}

// The bulk API takes 10,000 pairs and 100 MB a request; Wrangler sends 1,000.
const BATCH_KEYS = 1000;
const BATCH_BYTES = 50_000_000;

/**
 * Keeps this build's client files in the store and removes those no tab needs any more. Run it
 * before the Worker version that serves the build goes live. Uploads come first and the record
 * last, so a run that stops halfway is repeated in full by the next one.
 */
export async function retainBuildAssets(input: {
  api: Pick<CloudflareApi, "kv">;
  namespaceId: string;
  clientDir: string;
  /** A label for the build, such as its commit. */
  build: string;
  now?: Date;
  retainDays?: number;
  log?: (line: string) => void;
}): Promise<RetentionPlan> {
  const { kv } = input.api;
  const [files, recordText, stored] = await Promise.all([
    readBuildFiles(input.clientDir),
    kv.getText(input.namespaceId, RECORD_KEY),
    kv.listKeys(input.namespaceId, { prefix: assetKey(ASSET_PATH_PREFIX) }),
  ]);
  const plan = planRetention({
    record: recordText === undefined ? null : parseAssetRecord(recordText),
    build: input.build,
    files,
    stored,
    now: input.now ?? new Date(),
    retainDays: input.retainDays,
  });

  let batch: KvEntry[] = [];
  let bytes = 0;
  for (const key of plan.upload) {
    const value = (await readFile(join(input.clientDir, key))).toString("base64");
    if (batch.length === BATCH_KEYS || (batch.length && bytes + value.length > BATCH_BYTES)) {
      await kv.putMany(input.namespaceId, batch);
      batch = [];
      bytes = 0;
    }
    const metadata: PreviousAssetMetadata = { contentType: contentTypeOf(key) };
    batch.push({ key, value, base64: true, metadata });
    bytes += value.length;
  }
  if (batch.length) await kv.putMany(input.namespaceId, batch);
  for (let index = 0; index < plan.remove.length; index += BATCH_KEYS)
    await kv.deleteMany(input.namespaceId, plan.remove.slice(index, index + BATCH_KEYS));
  await kv.putMany(input.namespaceId, [{ key: RECORD_KEY, value: JSON.stringify(plan.record) }]);

  const kept = Object.values(plan.record.files).filter((since) => since !== null).length;
  input.log?.(
    `Earlier builds' client files: ${files.length} in this build (${plan.upload.length} new), ` +
      `${kept} kept from earlier builds, ${plan.remove.length} removed.`,
  );
  return plan;
}
