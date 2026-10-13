import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /** One uploaded build of the site. */
  versions: defineTable({
    versionId: v.string(),
    /**
     * `live` carries the time the first request of the version's pushed code marked it live, so a
     * version cannot have a live time without being live.
     */
    state: v.union(
      v.object({ kind: v.literal("uploading") }),
      v.object({ kind: v.literal("ready") }),
      v.object({ kind: v.literal("live"), at: v.number() }),
    ),
    /**
     * The JSON of Cloudflare's `AssetConfig`. A string, because `redirects.staticRules` has one
     * field per rule and Convex limits an object to 1,024 fields.
     */
    config: v.string(),
  }).index("by_versionId", ["versionId"]),

  /** One file of a version. */
  entries: defineTable({
    versionId: v.string(),
    /** The URL path of the file, such as `/assets/index-a1b2.js`. */
    path: v.string(),
    /**
     * Hex: the CLI computes it in hex and the ETag carries it in hex. The one conversion from the
     * base64 of Convex's `_storage` happens in `recordFiles`.
     */
    sha256: v.string(),
    /**
     * The type belongs to the path, not to the bytes: paths with identical bytes share one stored
     * file but keep their own types, and `route` serves without reading `_storage`. Absent when
     * the `mime` package has no type for the file name.
     */
    contentType: v.optional(v.string()),
    storageId: v.id("_storage"),
  })
    .index("by_version_path", ["versionId", "path"])
    .index("by_sha256", ["sha256"])
    .index("by_storageId", ["storageId"]),
});
