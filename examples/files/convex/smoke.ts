import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";

export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => await ctx.runAction(components.fileOwner.smoke.run, {}),
});
