import { createHash } from "node:crypto";
import type { NormalizedAssetConfig } from "../workers-sdk/packages/workers-shared/asset-worker/src/types.js";
import {
  CONTENT_HASH_OFFSET,
  CONTENT_HASH_SIZE,
  ENTRY_SIZE,
  HEADER_SIZE,
  PATH_HASH_OFFSET,
  PATH_HASH_SIZE,
} from "../workers-sdk/packages/workers-shared/utils/constants.js";
import {
  NO_CONTENT_TYPE,
  TAIL_CONTENT_TYPE,
  TAIL_URL,
  type AssetFiles,
} from "../client/manifest.js";

/** One file of a version, as the upload knows it. */
export type AssetEntry = {
  /** The URL path, such as `/assets/index-a1b2.js`. */
  path: string;
  /** The hex SHA-256 of the bytes. */
  sha256: string;
  contentType: string | undefined;
  /** The storage URL of the bytes. */
  url: string;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/**
 * Builds the files that serving reads. The manifest is encoded as Miniflare encodes it for
 * `wrangler dev`: a 20-byte header, then one 40-byte entry per path, sorted by the path hash. The
 * content hash covers the bytes and the content type, as Cloudflare's covers the bytes and the
 * extension, so the same bytes under two types are two entries with two ETags. The storage URLs
 * differ only in a key, so what they share is written once.
 */
export function buildAssetFiles(
  cloudUrl: string,
  config: NormalizedAssetConfig,
  entries: AssetEntry[],
): AssetFiles {
  // Sorted, so the same files write the same version file.
  const urls = [...new Set(entries.map(({ url }) => url))].sort();
  const contentTypes = [
    ...new Set(
      entries.flatMap(({ contentType }) => (contentType === undefined ? [] : [contentType])),
    ),
  ].sort();
  const urlIndex = new Map(urls.map((url, index) => [url, index]));
  const urlPrefix = sharedStart(urls);
  const urlSuffix = sharedEnd(urls.map((url) => url.slice(urlPrefix.length)));
  const keys = urls.map((url) => url.slice(urlPrefix.length, url.length - urlSuffix.length));
  const urlKeyWidth = keys.reduce((width, key) => Math.max(width, key.length), 0);
  const contentTypeIndex = new Map(contentTypes.map((type, index) => [type, index]));

  const sorted = entries
    .map((entry) => ({ entry, pathHash: sha256(entry.path).subarray(0, PATH_HASH_SIZE) }))
    .sort((a, b) => Buffer.compare(a.pathHash, b.pathHash));
  const manifest = Buffer.alloc(HEADER_SIZE + sorted.length * ENTRY_SIZE);
  sorted.forEach(({ entry, pathHash }, i) => {
    const offset = HEADER_SIZE + i * ENTRY_SIZE;
    pathHash.copy(manifest, offset + PATH_HASH_OFFSET);
    sha256(`${entry.sha256}\n${entry.contentType ?? ""}`).copy(
      manifest,
      offset + CONTENT_HASH_OFFSET,
      0,
      CONTENT_HASH_SIZE,
    );
    const tail = offset + CONTENT_HASH_OFFSET + CONTENT_HASH_SIZE;
    manifest.writeUInt32BE(urlIndex.get(entry.url) ?? 0, tail + TAIL_URL);
    manifest.writeUInt16BE(
      entry.contentType === undefined
        ? NO_CONTENT_TYPE
        : (contentTypeIndex.get(entry.contentType) ?? 0),
      tail + TAIL_CONTENT_TYPE,
    );
  });
  return {
    cloudUrl,
    config,
    manifest: manifest.toString("base64"),
    contentTypes,
    urlPrefix,
    urlSuffix,
    urlKeys: keys.map((key) => key.padEnd(urlKeyWidth)).join(""),
    urlKeyWidth,
  };
}

/** The longest start that all of `texts` share. */
function sharedStart(texts: string[]): string {
  let start = texts[0] ?? "";
  for (const text of texts) {
    let length = 0;
    while (length < start.length && start[length] === text[length]) length++;
    start = start.slice(0, length);
  }
  return start;
}

/** The longest end that all of `texts` share. */
function sharedEnd(texts: string[]): string {
  let end = texts[0] ?? "";
  for (const text of texts) {
    let length = 0;
    while (length < end.length && end.at(-1 - length) === text.at(-1 - length)) length++;
    end = end.slice(end.length - length);
  }
  return end;
}
