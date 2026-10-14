import { getAuthUserId } from "@convex-dev/auth/core";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server.js";

/** The `createUser` callback of the anonymous provider: each anonymous sign-in makes a user. */
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

/** The signed-in user, or `null` without a session. */
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
