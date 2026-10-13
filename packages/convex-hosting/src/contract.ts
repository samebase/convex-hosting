// The values that the CLI and the component must agree on (docs/contract-0.4.md). The CLI runs on
// Node and the component in the Convex runtime, so this file imports nothing.

/** Entries (files) per version. */
export const MAX_ENTRIES = 4000;
/** UTF-8 bytes per entry path. */
export const MAX_PATH_BYTES = 1024;
/** Bytes per file. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Bytes of a version's config as JSON. */
export const MAX_CONFIG_BYTES = 256 * 1024;

/** The characters of a version ID after `v_`: lowercase base32. */
export const VERSION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const VERSION_ID_LENGTH = 26;
export const VERSION_ID_PATTERN = new RegExp(`^v_[${VERSION_ID_ALPHABET}]{${VERSION_ID_LENGTH}}$`);

/** The first asset-worker compatibility date with navigation detection (`Sec-Fetch-Mode`). */
export const COMPATIBILITY_DATE = "2025-04-01";
