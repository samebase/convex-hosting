import { getAuthUserId } from "@convex-dev/auth/core";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";

// The site is public and sign-in is anonymous, so each user and each todo stays small.
const MAX_TODOS_PER_USER = 50;
const MAX_TEXT_LENGTH = 280;

export const latest = query({
  args: {},
  returns: v.array(
    v.object({ id: v.id("todos"), author: v.string(), text: v.string(), done: v.boolean() }),
  ),
  handler: async (ctx) => {
    const todos = await ctx.db.query("todos").order("desc").take(20);
    const names = new Map<Id<"users">, string>();
    for (const todo of todos) {
      if (!names.has(todo.userId)) {
        const user = await ctx.db.get("users", todo.userId);
        names.set(todo.userId, user?.name ?? "Guest");
      }
    }
    return todos.map((todo) => ({
      id: todo._id,
      author: names.get(todo.userId) ?? "Guest",
      text: todo.text,
      done: todo.done,
    }));
  },
});

export const list = query({
  args: {},
  returns: v.array(v.object({ id: v.id("todos"), text: v.string(), done: v.boolean() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const todos = await ctx.db
      .query("todos")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return todos.map((todo) => ({ id: todo._id, text: todo.text, done: todo.done }));
  },
});

export const add = mutation({
  args: { text: v.string() },
  returns: v.id("todos"),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to add a todo.");
    const text = args.text.trim();
    if (text === "") throw new Error("A todo needs some text.");
    if (text.length > MAX_TEXT_LENGTH) throw new Error(`At most ${MAX_TEXT_LENGTH} characters.`);
    const mine = await ctx.db
      .query("todos")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_TODOS_PER_USER);
    if (mine.length >= MAX_TODOS_PER_USER) throw new Error(`At most ${MAX_TODOS_PER_USER} todos.`);
    return await ctx.db.insert("todos", { userId, text, done: false });
  },
});

export const toggle = mutation({
  args: { id: v.id("todos") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const todo = await ctx.db.get("todos", args.id);
    if (todo === null || todo.userId !== userId) throw new Error("Not your todo.");
    await ctx.db.patch("todos", args.id, { done: !todo.done });
    return null;
  },
});
