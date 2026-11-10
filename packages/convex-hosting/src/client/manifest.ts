import {
  binarySearch,
  hashPath,
} from "../workers-sdk/packages/workers-shared/asset-worker/src/assets-manifest.js";
import type { NormalizedAssetConfig } from "../workers-sdk/packages/workers-shared/asset-worker/src/types.js";
import { CONTENT_HASH_SIZE } from "../workers-sdk/packages/workers-shared/utils/constants.js";

/**
 * The format of `Assets`. `serveSite` refuses assets of another format, which only a deploy with
 * another release of this package writes.
 */
export const ASSETS_FORMAT = 1;

/**
 * The static assets of one version, as `.convex-hosting/version.js` exports them under `assets`,
 * Cloudflare's name for them: the version's id, and everything that serving reads, so that a
 * request reads no database. `files` is `null` in the code that a first install pushes before its
 * upload, which serves nothing.
 */
export type Assets = {
  /** `ASSETS_FORMAT` of the release that wrote it. */
  format: number;
  versionId: string;
  files: AssetFiles | null;
};

export type AssetFiles = {
  /** The deployment's `CONVEX_CLOUD_URL` at the upload: the origin of every storage URL. */
  cloudUrl: string;
  /** Cloudflare's normalized `AssetConfig` for the version, as its handler takes it. */
  config: NormalizedAssetConfig;
  /**
   * Cloudflare's asset manifest, in base64, which Cloudflare's own reader searches. The tail of an
   * entry, which Cloudflare leaves zero, holds the indexes of its URL and its content type.
   */
  manifest: string;
  /** The content types of the entries. */
  contentTypes: string[];
  /**
   * The storage URL of each stored file is `urlPrefix`, its key, and `urlSuffix`. The keys are one
   * string, `urlKeyWidth` characters each, padded with spaces: Convex evaluates the module for
   * every request, and one string costs less than an array of 100,000.
   */
  urlPrefix: string;
  urlSuffix: string;
  urlKeys: string;
  urlKeyWidth: number;
};

/** Where an entry's tail, after the content hash, keeps the index of its URL (a big-endian u32). */
export const TAIL_URL = 0;
/** Where the tail keeps the index of the content type (a big-endian u16). */
export const TAIL_CONTENT_TYPE = 4;
/** The content type index of an entry without a content type. */
export const NO_CONTENT_TYPE = 0xffff;

/** The entry of a path. */
export type ManifestHit = {
  /** The hex of the content hash, which is the ETag, as on Cloudflare. */
  eTag: string;
  url: string;
  contentType: string | undefined;
};

/**
 * Decodes the manifest once, like Cloudflare's `AssetsManifest`, and returns its lookup: it finds the
 * entry of a path with Cloudflare's binary search, or returns `null`.
 */
export function manifestLookup(files: AssetFiles) {
  const manifest = fromBase64(files.manifest);
  return async (path: string): Promise<ManifestHit | null> => {
    const contentHash = binarySearch(manifest, await hashPath(path));
    if (contentHash === false) return null;
    const tail = new DataView(contentHash.buffer, contentHash.byteOffset + CONTENT_HASH_SIZE);
    const key = tail.getUint32(TAIL_URL) * files.urlKeyWidth;
    const contentType = tail.getUint16(TAIL_CONTENT_TYPE);
    return {
      eTag: Array.from(contentHash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      url:
        files.urlPrefix +
        files.urlKeys.slice(key, key + files.urlKeyWidth).trimEnd() +
        files.urlSuffix,
      contentType: contentType === NO_CONTENT_TYPE ? undefined : files.contentTypes[contentType],
    };
  };
}

/** Convex's runtime decodes base64 natively; Node before 25, where tests run, does not. */
function fromBase64(text: string): Uint8Array {
  const decoded = (Uint8Array as { fromBase64?: (text: string) => Uint8Array }).fromBase64?.(text);
  return decoded ?? Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
