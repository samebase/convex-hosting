import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import {
  constructHeaders,
  constructRedirects,
} from "../workers-shared/utils/configuration/constructConfiguration.js";
import { parseHeaders } from "../workers-shared/utils/configuration/parseHeaders.js";
import { parseRedirects } from "../workers-shared/utils/configuration/parseRedirects.js";
import { HEADERS_FILENAME, REDIRECTS_FILENAME } from "../workers-shared/utils/constants.js";
import {
  createPatternMatcher,
  getContentType,
  maybeGetFile,
} from "../workers-shared/utils/helpers.js";
import type { AssetConfig } from "../workers-shared/utils/types.js";
import type { SiteOptions } from "./args.js";
import type { LocalFile } from "./collectFiles.js";

/** The asset worker detects navigation requests (`Sec-Fetch-Mode: navigate`) from this date. */
export const COMPATIBILITY_DATE = "2025-04-01";
/** The component stores the config in one document field and rejects a larger one. */
export const MAX_CONFIG_BYTES = 256 * 1024;

const IMMUTABLE_PRESETS = new Map([
  ["vite", "/assets/**"],
  ["next", "/_next/static/**"],
  ["astro", "/_astro/**"],
  ["sveltekit", "/_app/immutable/**"],
]);

export const VERSION_ID_PATTERN = /^v_[a-z2-7]{26}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export type ManifestEntry = {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
  immutable: boolean;
};

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The version's serving config: the site options and the parsed root `_headers` and `_redirects`. */
export function buildConfig(
  dist: string,
  options: Pick<SiteOptions, "htmlHandling" | "notFoundHandling" | "basePath">,
): AssetConfig {
  const headersFile = join(dist, HEADERS_FILENAME);
  const redirectsFile = join(dist, REDIRECTS_FILENAME);
  const headers = maybeGetFile(headersFile);
  const redirects = maybeGetFile(redirectsFile);
  const config: AssetConfig = {
    compatibility_date: COMPATIBILITY_DATE,
    html_handling: options.htmlHandling,
    not_found_handling: options.notFoundHandling,
    base_path: options.basePath,
    ...constructHeaders({
      headers: headers === undefined ? undefined : parseHeaders(headers),
      headersFile,
      logger: console,
    }),
    ...constructRedirects({
      redirects:
        redirects === undefined
          ? undefined
          : parseRedirects(redirects, { htmlHandling: options.htmlHandling }),
      redirectsFile,
      logger: console,
    }),
  };
  const configBytes = Buffer.byteLength(JSON.stringify(config));
  if (configBytes > MAX_CONFIG_BYTES) {
    throw new Error(
      `The _headers and _redirects rules need ${configBytes} bytes. A version's config holds at most ${MAX_CONFIG_BYTES}.`,
    );
  }
  return config;
}

/**
 * Whether a path is immutable: its bytes never change, so the component may serve it from older
 * versions and with a one-year cache. `setting` is a preset name or a gitignore-style glob.
 */
export function immutableMatcher(setting: string): (path: string) => boolean {
  const matches = createPatternMatcher([IMMUTABLE_PRESETS.get(setting) ?? setting], true);
  return (path) => matches(path.slice(1));
}

export function contentTypeFor(path: string): string {
  return (
    getContentType(path) ??
    (path.startsWith("/.well-known/") && extname(path) === ""
      ? "application/json"
      : "application/octet-stream")
  );
}

export function manifestEntries(
  files: LocalFile[],
  isImmutable: (path: string) => boolean,
): ManifestEntry[] {
  return files.map((file) => {
    const bytes = readFileSync(file.localPath);
    return {
      path: file.path,
      sha256: sha256Hex(bytes),
      size: bytes.length,
      contentType: contentTypeFor(file.path),
      immutable: isImmutable(file.path),
    };
  });
}

/**
 * The ETag that the component serves for an entry: the key that its `exists` callback returns
 * (component contract version 2), so the same bytes with another content type get another ETag.
 */
export function entryETag(entry: Pick<ManifestEntry, "sha256" | "contentType">): string {
  return `"${entry.sha256}-${sha256Hex(entry.contentType).slice(0, 8)}"`;
}

/** The digest of what a version serves, without its ID. Equal digests mean equal manifests. */
export function manifestDigest(config: AssetConfig, entries: ManifestEntry[]): string {
  return sha256Hex(JSON.stringify({ config, entries }));
}

export function newVersionId(): string {
  // 256 is a multiple of 32, so every character is equally likely.
  return `v_${Array.from(randomBytes(26), (byte) => BASE32[byte % 32]).join("")}`;
}

export function versionFilePath(dist: string): string {
  return join(dist, ".convex-hosting", "version.json");
}

const storedVersion = z.object({
  versionId: z.string().regex(VERSION_ID_PATTERN),
  digest: z.string(),
});

/** The version file of `dist`, or null when it is missing or damaged. */
function readVersionFile(dist: string): z.infer<typeof storedVersion> | null {
  const stored = storedVersion.safeParse(parseJson(maybeGetFile(versionFilePath(dist))));
  return stored.success ? stored.data : null;
}

/**
 * The version ID for this upload: `explicit` when given (`deploy` makes it before the build), else
 * the stored one when the stored digest equals `digest`, so a rerun continues the same version,
 * else a new one. The result is stored with the digest.
 */
export function resolveVersionId(dist: string, digest: string, explicit: string | null): string {
  let versionId = explicit;
  if (versionId === null) {
    const stored = readVersionFile(dist);
    versionId = stored?.digest === digest ? stored.versionId : null;
  }
  versionId ??= newVersionId();
  const file = versionFilePath(dist);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ versionId, digest })}\n`);
  return versionId;
}

/** A damaged version file counts as a missing one. */
function parseJson(text: string | undefined): unknown {
  try {
    return text === undefined ? null : JSON.parse(text);
  } catch {
    return null;
  }
}
