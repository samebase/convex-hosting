import { getAuthUserId } from "@convex-dev/auth/core";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server.js";

const NAMES = ["Ash", "Birch", "Cedar", "Dune", "Elm", "Fern", "Grove", "Harbor", "Ivy", "Juniper"];

export const createUserAnonymous = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("anonymous"),
      accountId: v.string(),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    // A readable name instead of an id. Two users can share one; nothing depends on the name.
    const name = `${NAMES[Math.floor(Math.random() * NAMES.length)]} ${Math.floor(Math.random() * 900) + 100}`;
    return await ctx.db.insert("users", { name });
  },
});

export const me = query({
  args: {},
  returns: v.union(v.null(), v.object({ id: v.id("users"), name: v.string(), since: v.number() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get("users", userId);
    if (user === null) return null;
    return { id: user._id, name: user.name, since: user._creationTime };
  },
});
