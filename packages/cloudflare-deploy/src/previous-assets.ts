/**
 * Skew protection for a Worker's static assets. A Worker version serves only its own
 * build's files, so after a deploy a tab still running the previous build cannot load a lazily
 * imported chunk of it. Each deploy therefore copies its build's hashed client files into a KV
 * namespace first (`retainBuildAssets`, ./retain-assets.ts), and the Worker answers a request
 * under `/assets/` from that store.
 *
 * Workers Assets serves the current build's files before the Worker runs (no
 * `run_worker_first`), so only a file the current build lacks reaches this code. It uses only web
 * APIs: import it as `@rivi-software/cloudflare-deploy/previous-assets` from Worker code.
 */

/** The binding of the store in each app's Worker config. */
export const PREVIOUS_ASSETS_BINDING = "PREVIOUS_ASSETS";

/** Where Vite writes a build's hashed client files (`build.assetsDir`), as a URL path. */
export const ASSET_PATH_PREFIX = "/assets/";

/** What the deploy stores beside each file's bytes. */
export type PreviousAssetMetadata = { contentType: string };

/** The part of a KV namespace binding the Worker reads with. */
export type PreviousAssetStore = {
  getWithMetadata(
    key: string,
    type: "arrayBuffer",
  ): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
};

/** A file's key in the store: its URL path without the leading slash (`assets/index-abc.js`). */
export const assetKey = (pathname: string) => pathname.slice(1);

// KV refuses a key longer than 512 bytes; no build file has one.
const MAX_KEY_BYTES = 512;

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });

/** Whether the request reads a build file, which only the store may still hold. */
export function isAssetRequest(request: Request, url = new URL(request.url)) {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    url.pathname.startsWith(ASSET_PATH_PREFIX)
  );
}

/**
 * The answer to a request under `/assets/` that reached the Worker: the file of an earlier build
 * when the store holds it, else a 404. A build file's name carries its content hash, so a stored
 * file never changes and is cached for a year. Without a store (local development, Previews)
 * every such request is a 404.
 */
export async function servePreviousAsset(
  request: Request,
  store: PreviousAssetStore | undefined,
): Promise<Response> {
  // The store keys a file by its name as the build wrote it, a request names it percent-encoded
  // (`Über page-1.js` as `%C3%9Cber%20page-1.js`), and a malformed escape names no file at all.
  let key: string;
  try {
    key = assetKey(decodeURIComponent(new URL(request.url).pathname));
  } catch {
    return notFound();
  }
  const found =
    store && new TextEncoder().encode(key).length <= MAX_KEY_BYTES
      ? await store.getWithMetadata(key, "arrayBuffer")
      : null;
  if (!found?.value) return notFound();
  const metadata = found.metadata as Partial<PreviousAssetMetadata> | null;
  return new Response(request.method === "HEAD" ? null : found.value, {
    headers: {
      "content-type": metadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
