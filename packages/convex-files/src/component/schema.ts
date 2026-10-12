import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  files: defineTable({
    path: v.string(),
    storageId: v.id("_storage"),
  })
    .index("by_path", ["path"])
    .index("by_storageId", ["storageId"]),
});
