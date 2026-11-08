/**
 * AWS Signature Version 4 with Web Crypto alone, for the SES calls the Email SDK does not make. The SDK has a
 * signer of its own but does not export it. This one signs the same headers the SDK's SES adapter sends, so a
 * request signed here reaches SES as one from the adapter does.
 */

/** An AWS access key, and the region and service a request is signed for. */
export interface AwsSigning {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

/** A request to sign: the body as the string that is sent, the headers besides `host` and the `x-amz-*` ones. */
export interface AwsRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const utf8 = (value: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(value);

const hmac = async (
  key: Uint8Array<ArrayBuffer>,
  value: string
): Promise<Uint8Array<ArrayBuffer>> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, utf8(value))
  );
};

const sha256Hex = async (value: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value))));

// SigV4 sorts by character code; localeCompare would follow the runtime's locale.
const byCodeUnit = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

// encodeURIComponent leaves !'()* alone, which SigV4 wants encoded.
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replaceAll(
    /[!'()*]/gu,
    (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
  );

/** The query as SigV4 signs it: each name and value encoded as RFC 3986 says, sorted by name, then by value. */
const canonicalQuery = (params: URLSearchParams): string =>
  [...params]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .toSorted(([an, av], [bn, bv]) => byCodeUnit(an, bn) || byCodeUnit(av, bv))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

/**
 * The headers to send `request` with: its own, `x-amz-content-sha256`, `x-amz-date` and `Authorization`. `host`
 * is signed but left out, since `fetch` sets it from the URL. `now` is for a test's fixed clock.
 */
export const signAwsRequest = async (
  request: AwsRequest,
  signing: AwsSigning,
  now: Date = new Date()
): Promise<Record<string, string>> => {
  const amzDate = now.toISOString().replaceAll(/[:-]|\.\d{3}/gu, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(request.body);

  const headers = {
    ...request.headers,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  const canonicalHeaders = Object.entries({
    ...headers,
    host: request.url.host,
  })
    .map(
      ([name, value]) =>
        [name.toLowerCase(), value.trim().replaceAll(/\s+/gu, " ")] as const
    )
    .toSorted(([a], [b]) => byCodeUnit(a, b));

  const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");
  const scope = `${dateStamp}/${signing.region}/${signing.service}/aws4_request`;

  const canonicalRequest = [
    request.method.toUpperCase(),
    // As the URL holds it, encoded once: what S3 signs, and the same as twice for a path of unreserved
    // characters alone, such as SES's.
    request.url.pathname || "/",
    canonicalQuery(request.url.searchParams),
    canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key = await hmac(utf8(`AWS4${signing.secretAccessKey}`), dateStamp);

  for (const part of [signing.region, signing.service, "aws4_request"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each HMAC signs with the key the one before it produced
    key = await hmac(key, part);
  }

  const signature = hex(await hmac(key, stringToSign));

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${signing.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};
