import { getAuthUserId } from "@convex-dev/auth/core";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server.js";

export const createUserAnonymous = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("anonymous"),
      accountId: v.string(),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: (ctx) => ctx.db.insert("users", {}),
});

export const me = query({
  args: {},
  returns: v.union(v.null(), v.object({ id: v.id("users"), since: v.number() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get("users", userId);
    if (user === null) return null;
    return { id: user._id, since: user._creationTime };
  },
});
