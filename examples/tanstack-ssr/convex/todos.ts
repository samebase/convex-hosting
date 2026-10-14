import { getAuthUserId } from "@convex-dev/auth/core";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const count = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("stats").first())?.todos ?? 0,
});

export const list = query({
  args: {},
  returns: v.array(v.object({ id: v.id("todos"), text: v.string() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const todos = await ctx.db
      .query("todos")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return todos.map((todo) => ({ id: todo._id, text: todo.text }));
  },
});

export const add = mutation({
  args: { text: v.string() },
  returns: v.id("todos"),
  handler: async (ctx, { text }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to add a todo.");
    const stats = await ctx.db.query("stats").first();
    if (stats === null) await ctx.db.insert("stats", { todos: 1 });
    else await ctx.db.patch("stats", stats._id, { todos: stats.todos + 1 });
    return await ctx.db.insert("todos", { userId, text });
  },
});
