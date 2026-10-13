import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /** One uploaded build of the site. */
  versions: defineTable({
    versionId: v.string(),
    state: v.union(v.literal("uploading"), v.literal("ready")),
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
    /** Absent when the `mime` package has no type for the file name. */
    contentType: v.optional(v.string()),
    /** Absent until `recordFiles` attaches the stored file. */
    storageId: v.optional(v.id("_storage")),
  })
    .index("by_version_path", ["versionId", "path"])
    // `storageId` sorts after the sha256, so a descending read finds a recorded entry first.
    .index("by_sha256", ["sha256", "storageId"])
    .index("by_storageId", ["storageId"])
    // With `storageId` equal to `undefined`: the version's entries without a file.
    .index("by_version_storageId", ["versionId", "storageId"]),

  /** The deploy lock: one row at most, for the version whose deploy is in flight. */
  deploy: defineTable({
    versionId: v.string(),
    lastCallAt: v.number(),
  }),
});
