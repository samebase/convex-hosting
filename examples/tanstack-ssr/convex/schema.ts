import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  counter: defineTable({ count: v.number() }),
  // One document for each Convex Auth user. The auth components keep the accounts and sessions.
  users: defineTable({}),
});
