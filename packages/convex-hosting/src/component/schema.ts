import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per upload. A version owns its entries and their storage objects.
  versions: defineTable({
    versionId: v.string(),
    state: v.union(v.literal("uploading"), v.literal("ready"), v.literal("deleting")),
    // The asset worker's AssetConfig as a JSON string. Static redirects are keyed by path, and a
    // Convex object allows only 1,024 fields.
    config: v.string(),
    manifestSha256: v.string(),
    entryCount: v.number(),
    createdAt: v.number(),
    // The most recent activation.
    liveAt: v.optional(v.number()),
    // When a later activation replaced this version as the live one.
    supersededAt: v.optional(v.number()),
    // Whether the most recent activation came after a code push (`deploy`), so this version's
    // renderer replaced the renderer of every version created before it.
    activatedAfterCodePush: v.optional(v.boolean()),
  })
    .index("by_versionId", ["versionId"])
    .index("by_state", ["state"])
    .index("by_codePush_liveAt", ["activatedAfterCodePush", "liveAt"]),

  // The manifest of a version: one row per file. `storageId` is set when the file is recorded.
  entries: defineTable({
    versionId: v.string(),
    path: v.string(),
    // Lowercase hex SHA-256 of the file.
    sha256: v.string(),
    size: v.number(),
    contentType: v.string(),
    immutable: v.boolean(),
    storageId: v.optional(v.id("_storage")),
  })
    .index("by_version_path", ["versionId", "path"])
    .index("by_immutable_path", ["immutable", "path"])
    .index("by_storageId", ["storageId"]),

  // One row: the live version and the cursors of the cleanup scans.
  site: defineTable({
    liveVersionId: v.optional(v.string()),
    // The `_creationTime` of the last version that cleanup checked.
    versionScanCursor: v.optional(v.number()),
    storageScanCursor: v.optional(v.string()),
  }),
});
