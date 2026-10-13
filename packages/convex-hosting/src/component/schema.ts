import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per upload. A version owns its entries and their storage objects.
  versions: defineTable({
    versionId: v.string(),
    state: v.union(v.literal("uploading"), v.literal("ready"), v.literal("deleting")),
    manifestSha256: v.string(),
    entryCount: v.number(),
    createdAt: v.number(),
    // The most recent activation. A version that is not live and has it was superseded.
    liveAt: v.optional(v.number()),
    // The most recent activation that came after a code push (`deploy`): from then on the backend
    // ran this version's renderer. A file-only activation never clears it.
    codePushAt: v.optional(v.number()),
  })
    .index("by_versionId", ["versionId"])
    .index("by_state", ["state"])
    .index("by_codePushAt", ["codePushAt"]),

  // The config of a version, apart from `versions` so that a page of version rows stays small.
  versionConfigs: defineTable({
    versionId: v.string(),
    // The asset worker's AssetConfig as a JSON string, at most 256 KiB. Static redirects are keyed
    // by path, and a Convex object allows only 1,024 fields.
    config: v.string(),
  }).index("by_versionId", ["versionId"]),

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
    // True from the transaction that makes the version ready. Cleanup deletes the entries of a
    // `deleting` version, so this is never set back to false.
    ready: v.boolean(),
  })
    .index("by_version_path", ["versionId", "path"])
    .index("by_ready_immutable_path", ["ready", "immutable", "path"])
    .index("by_storageId", ["storageId"]),

  // One row: the live version and the cursors of the cleanup scans.
  site: defineTable({
    liveVersionId: v.optional(v.string()),
    // The `_creationTime` of the last version and of the last `_storage` object that cleanup
    // checked.
    versionScanCursor: v.optional(v.number()),
    storageScanCursor: v.optional(v.number()),
  }),
});
