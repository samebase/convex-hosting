import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { internalMutation, query } from "./_generated/server.js";

export const createUser = internalMutation({
  args: { method: v.object({ name: v.literal("usernamePassword"), profile: v.object({}) }) },
  returns: v.id("users"),
  // The username component keeps the username; the user document holds nothing yet.
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const me = query({
  args: {},
  returns: v.union(v.null(), v.object({ id: v.id("users"), name: v.string(), since: v.number() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get("users", userId);
    if (user === null) return null;
    const name = await ctx.runQuery(components.authUsername.public.getUsername, { userId });
    return { id: user._id, name: name ?? "Guest", since: user._creationTime };
  },
});
