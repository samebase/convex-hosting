import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const assetFields = {
  path: v.string(),
  fileId: v.string(),
  contentType: v.string(),
  deploymentId: v.string(),
};

export default defineSchema({
  staticAssets: defineTable(assetFields)
    .index("by_path", ["path"])
    .index("by_deploymentId", ["deploymentId"])
    .index("by_fileId", ["fileId"]),

  // Replaced files remain available for at least seven days. Missing non-HTML
  // paths with an extension can resolve to the newest retained file.
  retiredAssets: defineTable({
    ...assetFields,
    expiresAt: v.number(),
  })
    .index("by_path", ["path"])
    .index("by_fileId", ["fileId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Only publishDeployment makes the complete staged manifest visible.
  stagedAssets: defineTable(assetFields)
    .index("by_deploymentId", ["deploymentId"])
    .index("by_fileId", ["fileId"]),

  pendingStorageCleanup: defineTable({ fileId: v.string() }),

  // The cursor survives the CLI's per-run maintenance limit.
  cleanupState: defineTable({ fileStorageCleanupCursor: v.string() }),

  deploymentInfo: defineTable({
    currentDeploymentId: v.string(),
    deployedAt: v.number(),
    spaFallback: v.optional(v.boolean()),
  }),
});
