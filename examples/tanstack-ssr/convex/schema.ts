import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  todos: defineTable({ userId: v.id("users"), text: v.string() }).index("by_user", ["userId"]),
  // One document for each Convex Auth user. The auth components keep the accounts and sessions.
  users: defineTable({}),
});
