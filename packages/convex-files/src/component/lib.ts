import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import schema from "./schema.js";

const fileRecord = schema.doc("files");
const inspectedFile = fileRecord.extend({
  url: v.union(v.string(), v.null()),
  metadata: v.union(
    v.object({
      _id: v.id("_storage"),
      _creationTime: v.number(),
      contentType: v.optional(v.string()),
      sha256: v.string(),
      size: v.number(),
    }),
    v.null(),
  ),
});

function validatePath(path: string) {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    /\p{Cc}/u.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Path must be a canonical relative path.");
  }
}

async function inspectFile(ctx: QueryCtx, file: Doc<"files"> | null) {
  if (!file) return null;
  const [url, metadata] = await Promise.all([
    ctx.storage.getUrl(file.storageId),
    ctx.db.system.get("_storage", file.storageId),
  ]);
  return { ...file, url, metadata };
}

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const register = mutation({
  args: {
    path: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.id("files"),
  handler: async (ctx, { path, storageId }) => {
    validatePath(path);
    const [metadata, existingPath, existingStorage] = await Promise.all([
      ctx.db.system.get("_storage", storageId),
      ctx.db
        .query("files")
        .withIndex("by_path", (q) => q.eq("path", path))
        .unique(),
      ctx.db
        .query("files")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
        .unique(),
    ]);
    if (!metadata) throw new Error("Storage file not found.");
    if (existingPath) {
      if (existingPath.storageId === storageId) return existingPath._id;
      throw new Error("Path already exists.");
    }
    if (existingStorage) throw new Error("Storage file already registered.");
    return await ctx.db.insert("files", { path, storageId });
  },
});

export const get = query({
  args: { fileId: v.id("files") },
  returns: v.union(inspectedFile, v.null()),
  handler: async (ctx, { fileId }) => await inspectFile(ctx, await ctx.db.get("files", fileId)),
});

export const getByPath = query({
  args: { path: v.string() },
  returns: v.union(inspectedFile, v.null()),
  handler: async (ctx, { path }) => {
    validatePath(path);
    const file = await ctx.db
      .query("files")
      .withIndex("by_path", (q) => q.eq("path", path))
      .unique();
    return await inspectFile(ctx, file);
  },
});

export const list = query({
  args: {
    prefix: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(fileRecord),
  handler: async (ctx, { prefix, paginationOpts }) => {
    // Convex orders strings by UTF-8, so the exclusive bound uses Unicode scalar order.
    const characters = Array.from(prefix);
    let upperBound: string | null = null;
    for (let index = characters.length - 1; index >= 0; index--) {
      const codePoint = characters[index]?.codePointAt(0);
      if (codePoint !== undefined && codePoint < 0x10ffff) {
        const nextCodePoint = codePoint === 0xd7ff ? 0xe000 : codePoint + 1;
        upperBound = characters.slice(0, index).join("") + String.fromCodePoint(nextCodePoint);
        break;
      }
    }
    return await paginator(ctx.db, schema)
      .query("files")
      .withIndex("by_path", (q) => {
        const range = q.gte("path", prefix);
        return upperBound === null ? range : range.lt("path", upperBound);
      })
      .paginate(paginationOpts);
  },
});

export const rename = mutation({
  args: { fileId: v.id("files"), path: v.string() },
  returns: v.null(),
  handler: async (ctx, { fileId, path }) => {
    validatePath(path);
    const file = await ctx.db.get("files", fileId);
    if (!file) throw new Error("File not found.");
    if (file.path === path) return null;
    const existingPath = await ctx.db
      .query("files")
      .withIndex("by_path", (q) => q.eq("path", path))
      .unique();
    if (existingPath) throw new Error("Path already exists.");
    await ctx.db.patch("files", fileId, { path });
    return null;
  },
});

export const remove = mutation({
  args: { fileId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get("files", fileId);
    if (!file) return null;
    if (await ctx.db.system.get("_storage", file.storageId)) {
      await ctx.storage.delete(file.storageId);
    }
    await ctx.db.delete("files", fileId);
    return null;
  },
});

const CLEANUP_PAGE_SIZE = 128;

export const cleanupUnregistered = mutation({
  args: {
    before: v.number(),
    cursor: v.optional(v.id("_storage")),
  },
  returns: v.object({
    scanned: v.number(),
    deleted: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.id("_storage"), v.null()),
  }),
  handler: async (ctx, { before, cursor }) => {
    if (!Number.isFinite(before) || before > Date.now()) {
      throw new Error("Cleanup cutoff must be a finite timestamp at or before now.");
    }
    // An ID cursor remains usable when this page deletes its last scanned file.
    const candidates = await ctx.db.system
      .query("_storage")
      .withIndex("by_id", (q) => (cursor === undefined ? q : q.gt("_id", cursor)))
      .take(CLEANUP_PAGE_SIZE + 1);
    const page = candidates.slice(0, CLEANUP_PAGE_SIZE);
    let deleted = 0;
    for (const storageFile of page) {
      if (storageFile._creationTime >= before) continue;
      const registered = await ctx.db
        .query("files")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageFile._id))
        .unique();
      if (registered) continue;
      await ctx.storage.delete(storageFile._id);
      deleted++;
    }
    const isDone = candidates.length <= CLEANUP_PAGE_SIZE;
    return {
      scanned: page.length,
      deleted,
      isDone,
      continueCursor: isDone ? null : (page[page.length - 1]?._id ?? null),
    };
  },
});
