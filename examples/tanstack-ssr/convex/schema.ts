import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  todos: defineTable({ userId: v.id("users"), text: v.string() }).index("by_user", ["userId"]),
  // One document: the number of todos, so that the public count does not read every todo.
  stats: defineTable({ todos: v.number() }),
  // One document for each Convex Auth user. The auth components keep the accounts and sessions.
  users: defineTable({}),
});
