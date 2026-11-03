import type { NormalizedAssetConfig } from "../workers-sdk/packages/workers-shared/asset-worker/src/types.js";
import {
  CONTENT_HASH_OFFSET,
  CONTENT_HASH_SIZE,
  ENTRY_SIZE,
  HEADER_SIZE,
  PATH_HASH_OFFSET,
  PATH_HASH_SIZE,
} from "../workers-sdk/packages/workers-shared/utils/constants.js";

/**
 * The format of `Site`. `serveSite` refuses a site of another format, which only a deploy with
 * another release of this package writes.
 */
export const SITE_FORMAT = 1;

/**
 * The header with which the CLI, after the push, asks the served code to mark its version live. Its
 * value is the site's `markToken`; a request without it is an ordinary request.
 */
export const MARK_HEADER = "Convex-Hosting-Mark";

/** The path of that request, which names it in logs; the header alone decides. */
export const MARK_PATH = "/.convex-hosting/mark";

/**
 * The site that one deploy pushes, as `.convex-hosting/version.js` exports it: the version's id,
 * and everything that serving reads, so that a request reads no database. `files` is `null` in the
 * code that a first install pushes before its upload, which serves nothing.
 */
export type Site = {
  /** `SITE_FORMAT` of the release that wrote it. */
  format: number;
  versionId: string;
  /**
   * The CLI sends it after the push, so that only the CLI makes the served code mark its version
   * live; another request with the header pays nothing more than any other request.
   */
  markToken: string;
  files: SiteFiles | null;
};

export type SiteFiles = {
  /** The deployment's `CONVEX_CLOUD_URL` at the upload: the origin of every storage URL. */
  cloudUrl: string;
  /** Cloudflare's normalized `AssetConfig` for the version, as its handler takes it. */
  config: NormalizedAssetConfig;
  /** The base64 of the manifest bytes; see `buildSiteFiles`. */
  manifest: string;
  /** The content types of the entries, sorted; an entry holds an index into it. */
  contentTypes: string[];
  /**
   * The storage URL of each stored file, sorted: `prefix`, then the file's `width` characters of
   * `keys`, then `suffix`. Convex's storage URLs of one component share all but the file's key.
   */
  storage: { prefix: string; suffix: string; width: number; keys: string };
};

/** One file of a version, as the upload knows it. */
export type SiteEntry = {
  /** The URL path, such as `/assets/index-a1b2.js`. */
  path: string;
  /** The hex SHA-256 of the bytes. */
  sha256: string;
  contentType: string | undefined;
  /** The storage URL of the bytes. */
  url: string;
};

/** Where an entry's tail keeps the index of its stored file (a big-endian u32). */
const FILE_OFFSET = CONTENT_HASH_OFFSET + CONTENT_HASH_SIZE;
/** Where an entry's tail keeps the index of its content type (a big-endian u16). */
const CONTENT_TYPE_OFFSET = FILE_OFFSET + 4;
/** The content type index of an entry without a content type. */
const NO_CONTENT_TYPE = 0xffff;

/** One entry that `lookup` found. */
export type ManifestHit = {
  /** The hex of the manifest's content hash: the first 16 bytes of the SHA-256 of the bytes. */
  contentHash: string;
  /** The index of the stored file in `SiteFiles.storage`. */
  file: number;
  /** The entry's content type, if it has one. */
  contentType: string | undefined;
};

/** The first 16 bytes of the SHA-256 of the UTF-8 of `path`: Cloudflare's path hash. */
async function hashPath(path: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  return new Uint8Array(digest, 0, PATH_HASH_SIZE);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** The position of each value of `values`, which has no repeats. */
function indexOf(values: string[]): (value: string) => number {
  const positions = new Map(values.map((value, index) => [value, index]));
  return (value) => {
    const position = positions.get(value);
    if (position === undefined) throw new Error(`${value} is not in the list it was taken from.`);
    return position;
  };
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * The storage URLs as one shared prefix and suffix around one key per file, each key padded with
 * spaces to the width of the longest, since a URL has no space. Convex's URLs of one component
 * differ only in the file's key, but that is Convex's choice, so the split is computed, and every
 * URL is rebuilt from it and compared before it is used.
 */
function compressUrls(urls: string[]): SiteFiles["storage"] {
  if (urls.length === 0) return { prefix: "", suffix: "", width: 0, keys: "" };
  let prefixLength = urls[0].length;
  for (const url of urls) prefixLength = Math.min(prefixLength, commonPrefixLength(urls[0], url));
  const rests = urls.map((url) => url.slice(prefixLength));
  let suffixLength = rests[0].length;
  for (const rest of rests)
    suffixLength = Math.min(suffixLength, commonSuffixLength(rests[0], rest));
  const keys = rests.map((rest) => rest.slice(0, rest.length - suffixLength));
  const width = Math.max(...keys.map((key) => key.length));
  const storage = {
    prefix: urls[0].slice(0, prefixLength),
    suffix: rests[0].slice(rests[0].length - suffixLength),
    width,
    keys: keys.map((key) => key.padEnd(width, " ")).join(""),
  };
  urls.forEach((url, file) => {
    if (storageUrl(storage, file) !== url) {
      throw new Error(`The storage URL ${url} does not survive its compression.`);
    }
  });
  return storage;
}

/**
 * Builds the files of a site. The manifest is Cloudflare's: a 20-byte header (zero, unused, as in
 * Cloudflare's) and one 40-byte entry per path, sorted by the path hash, so that a lookup is a
 * binary search. An entry is the path hash, the content hash, and a tail, which here holds the
 * index of the stored file and the index of the content type.
 */
export async function buildSiteFiles(
  cloudUrl: string,
  config: NormalizedAssetConfig,
  entries: SiteEntry[],
): Promise<SiteFiles> {
  const urls = [...new Set(entries.map(({ url }) => url))].sort();
  const contentTypes = [
    ...new Set(
      entries.flatMap(({ contentType }) => (contentType === undefined ? [] : [contentType])),
    ),
  ].sort();
  if (contentTypes.length >= NO_CONTENT_TYPE)
    throw new Error("The site has too many content types.");
  const fileIndex = indexOf(urls);
  const contentTypeIndex = indexOf(contentTypes);

  const hashed = await Promise.all(
    entries.map(async (entry) => ({ entry, pathHash: await hashPath(entry.path) })),
  );
  hashed.sort((a, b) => compareBytes(a.pathHash, b.pathHash));
  const bytes = new Uint8Array(HEADER_SIZE + hashed.length * ENTRY_SIZE);
  const view = new DataView(bytes.buffer);
  hashed.forEach(({ entry, pathHash }, i) => {
    if (i > 0 && compareBytes(hashed[i - 1].pathHash, pathHash) === 0) {
      throw new Error(`${hashed[i - 1].entry.path} and ${entry.path} have the same path hash.`);
    }
    const offset = HEADER_SIZE + i * ENTRY_SIZE;
    bytes.set(pathHash, offset + PATH_HASH_OFFSET);
    bytes.set(
      hexToBytes(entry.sha256).subarray(0, CONTENT_HASH_SIZE),
      offset + CONTENT_HASH_OFFSET,
    );
    view.setUint32(offset + FILE_OFFSET, fileIndex(entry.url));
    view.setUint16(
      offset + CONTENT_TYPE_OFFSET,
      entry.contentType === undefined ? NO_CONTENT_TYPE : contentTypeIndex(entry.contentType),
    );
  });

  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { cloudUrl, config, manifest: btoa(binary), contentTypes, storage: compressUrls(urls) };
}

/**
 * `length` bytes of the base64 `text` from byte `offset`, decoding only the base64 groups that hold
 * them, so that a lookup costs the same for any size of manifest.
 */
function bytesAt(text: string, offset: number, length: number): Uint8Array {
  const start = Math.floor(offset / 3);
  const end = Math.ceil((offset + length) / 3);
  const decoded = atob(text.slice(start * 4, end * 4));
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = decoded.charCodeAt(offset - start * 3 + i);
  return bytes;
}

/** The number of entries of a base64 manifest. */
function entryCount(manifest: string): number {
  const padding = manifest.endsWith("==") ? 2 : manifest.endsWith("=") ? 1 : 0;
  return ((manifest.length / 4) * 3 - padding - HEADER_SIZE) / ENTRY_SIZE;
}

/** Finds the entry of `path` by binary search over the path hashes, or returns `null`. */
export async function lookup(files: SiteFiles, path: string): Promise<ManifestHit | null> {
  const pathHash = await hashPath(path);
  let low = 0;
  let high = entryCount(files.manifest) - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const offset = HEADER_SIZE + middle * ENTRY_SIZE;
    const order = compareBytes(
      pathHash,
      bytesAt(files.manifest, offset + PATH_HASH_OFFSET, PATH_HASH_SIZE),
    );
    if (order < 0) {
      high = middle - 1;
    } else if (order > 0) {
      low = middle + 1;
    } else {
      const entry = bytesAt(files.manifest, offset, ENTRY_SIZE);
      const view = new DataView(entry.buffer);
      const contentType = view.getUint16(CONTENT_TYPE_OFFSET);
      return {
        contentHash: bytesToHex(entry.subarray(CONTENT_HASH_OFFSET, FILE_OFFSET)),
        file: view.getUint32(FILE_OFFSET),
        contentType: contentType === NO_CONTENT_TYPE ? undefined : files.contentTypes[contentType],
      };
    }
  }
  return null;
}

/** The storage URL of stored file `file`. */
export function storageUrl(storage: SiteFiles["storage"], file: number): string {
  const key = storage.keys.slice(file * storage.width, (file + 1) * storage.width).trimEnd();
  return storage.prefix + key + storage.suffix;
}
