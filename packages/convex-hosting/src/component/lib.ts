import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { components } from "./_generated/api.js";
import schema from "./schema.js";
import { hasFileExtension, isHtmlContentType } from "./serving.js";

const staticAssetValidator = schema.doc("staticAssets");
const resolvedAssetValidator = v.union(
  staticAssetValidator.extend({ storageUrl: v.optional(v.string()) }),
  schema.doc("retiredAssets").extend({ storageUrl: v.optional(v.string()) }),
);

const MAX_ASSETS_PER_DEPLOYMENT = 1800;
const MAX_PUBLISH_MANIFEST_READS = 3800;
const MAX_MANIFEST_SERIALIZED_BYTES = 2 * 1024 * 1024;
const MAINTENANCE_PAGE_LIMIT = 256;
const ABANDONED_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;
const RETIRED_ASSET_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function resolveAssetDocument(
  ctx: QueryCtx,
  path: string,
  spaFallbackOverride?: boolean,
): Promise<Doc<"staticAssets"> | Doc<"retiredAssets"> | null> {
  const exact = await ctx.db
    .query("staticAssets")
    .withIndex("by_path", (q) => q.eq("path", path))
    .unique();
  if (exact) return exact;

  if (hasFileExtension(path)) {
    const retired = await ctx.db
      .query("retiredAssets")
      .withIndex("by_path", (q) => q.eq("path", path))
      .order("desc")
      .first();
    if (retired && !isHtmlContentType(retired.contentType)) return retired;
    return null;
  }

  const info = await ctx.db.query("deploymentInfo").first();
  const spaFallback = spaFallbackOverride ?? info?.spaFallback ?? true;
  if (!spaFallback) return null;

  return await ctx.db
    .query("staticAssets")
    .withIndex("by_path", (q) => q.eq("path", "/index.html"))
    .unique();
}

async function deleteUnreferencedFile(ctx: MutationCtx, fileId: string) {
  const [live, staged, retired] = await Promise.all([
    ctx.db
      .query("staticAssets")
      .withIndex("by_fileId", (q) => q.eq("fileId", fileId))
      .first(),
    ctx.db
      .query("stagedAssets")
      .withIndex("by_fileId", (q) => q.eq("fileId", fileId))
      .first(),
    ctx.db
      .query("retiredAssets")
      .withIndex("by_fileId", (q) => q.eq("fileId", fileId))
      .first(),
  ]);
  if (live || staged || retired) return false;
  const file = await ctx.runQuery(components.files.lib.get, { fileId });
  if (!file) return false;
  await ctx.runMutation(components.files.lib.remove, { fileId });
  return true;
}

export const getCurrentDeployment = query({
  args: {},
  returns: v.union(schema.doc("deploymentInfo"), v.null()),
  handler: async (ctx) => await ctx.db.query("deploymentInfo").first(),
});

export const resolveAssetForHttp = query({
  args: { path: v.string(), spaFallback: v.optional(v.boolean()) },
  returns: v.union(
    v.object({
      storageUrl: v.optional(v.string()),
      contentType: v.string(),
      etag: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, { path, spaFallback }) => {
    const asset = await resolveAssetDocument(ctx, path, spaFallback);
    if (!asset) return null;
    const file = await ctx.runQuery(components.files.lib.get, { fileId: asset.fileId });
    return {
      ...(file?.url ? { storageUrl: file.url } : {}),
      contentType: asset.contentType,
      etag: `"${asset.fileId}"`,
    };
  },
});

export const getUrls = internalQuery({
  args: {},
  returns: v.object({ siteUrl: v.string(), cloudUrl: v.string() }),
  handler: async () => ({
    siteUrl: process.env.CONVEX_SITE_URL!,
    cloudUrl: process.env.CONVEX_CLOUD_URL!,
  }),
});

export const getByPath = internalQuery({
  args: { path: v.string() },
  returns: v.union(staticAssetValidator, v.null()),
  handler: async (ctx, { path }) =>
    await ctx.db
      .query("staticAssets")
      .withIndex("by_path", (q) => q.eq("path", path))
      .unique(),
});

export const resolveAsset = internalQuery({
  args: { path: v.string() },
  returns: v.union(resolvedAssetValidator, v.null()),
  handler: async (ctx, { path }) => {
    const asset = await resolveAssetDocument(ctx, path);
    if (!asset) return null;
    const file = await ctx.runQuery(components.files.lib.get, { fileId: asset.fileId });
    return { ...asset, ...(file?.url ? { storageUrl: file.url } : {}) };
  },
});

export const listAssets = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(staticAssetValidator),
  handler: async (ctx, { limit }) =>
    await ctx.db
      .query("staticAssets")
      .order("asc")
      .take(limit ?? 100),
});

export const generateUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.runMutation(components.files.lib.generateUploadUrl, {}),
});

export const generateUploadUrls = internalMutation({
  args: { count: v.number() },
  returns: v.array(v.string()),
  handler: async (ctx, { count }) => {
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error("Upload URL batch size must be an integer from 1 to 100");
    }
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
      urls.push(await ctx.runMutation(components.files.lib.generateUploadUrl, {}));
    }
    return urls;
  },
});

export const cleanupPendingStorage = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ processed: v.number(), deleted: v.number(), needsAnotherPass: v.boolean() }),
  handler: async (ctx, { limit }) => {
    const batchLimit = Math.min(limit ?? MAINTENANCE_PAGE_LIMIT, MAINTENANCE_PAGE_LIMIT);
    const expired = await ctx.db
      .query("retiredAssets")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(batchLimit);
    for (const asset of expired) {
      await ctx.db.insert("pendingStorageCleanup", { fileId: asset.fileId });
      await ctx.db.delete("retiredAssets", asset._id);
    }
    const entries = await ctx.db.query("pendingStorageCleanup").take(batchLimit);
    let deleted = 0;
    for (const entry of entries) {
      if (await deleteUnreferencedFile(ctx, entry.fileId)) deleted++;
      await ctx.db.delete("pendingStorageCleanup", entry._id);
    }
    return {
      processed: entries.length,
      deleted,
      needsAnotherPass: entries.length === batchLimit || expired.length === batchLimit,
    };
  },
});

export const deleteUploadedFiles = internalMutation({
  args: { fileStorageIds: v.array(v.string()) },
  returns: v.object({
    deleted: v.number(),
    alreadyMissing: v.number(),
    stillReferenced: v.number(),
  }),
  handler: async (ctx, { fileStorageIds }) => {
    let deleted = 0;
    let alreadyMissing = 0;
    let stillReferenced = 0;
    for (const storageId of fileStorageIds) {
      const result = await ctx.runMutation(components.files.lib.removeUnregistered, { storageId });
      switch (result) {
        case "deleted":
          deleted++;
          break;
        case "registered":
          stillReferenced++;
          break;
        case "missing":
          alreadyMissing++;
          break;
        default:
          result satisfies never;
      }
    }
    return { deleted, alreadyMissing, stillReferenced };
  },
});

export const stageAssets = internalMutation({
  args: {
    assets: v.array(
      v.object({
        path: v.string(),
        fileStorageId: v.string(),
        contentType: v.string(),
        deploymentId: v.string(),
      }),
    ),
  },
  returns: v.object({ staged: v.number() }),
  handler: async (ctx, { assets }) => {
    if (assets.length === 0 || assets.length > 100) {
      throw new Error("A staged chunk must contain between 1 and 100 files");
    }
    const deploymentId = assets[0].deploymentId;
    if (deploymentId === "" || deploymentId.includes("/")) {
      throw new Error("A deployment ID must be a non-empty path segment");
    }
    for (const asset of assets) {
      if (asset.deploymentId !== deploymentId) {
        throw new Error("A staged asset chunk must use one deploymentId");
      }
      if (!asset.path.startsWith("/")) {
        throw new Error("A file asset needs an absolute URL path");
      }
      const fileId = await ctx.runMutation(components.files.lib.register, {
        path: `deployments/${deploymentId}${asset.path}`,
        storageId: asset.fileStorageId,
      });
      await ctx.db.insert("stagedAssets", {
        path: asset.path,
        fileId,
        contentType: asset.contentType,
        deploymentId,
      });
    }
    return { staged: assets.length };
  },
});

export const discardStagedDeployment = internalMutation({
  args: { deploymentId: v.string() },
  returns: v.object({ discarded: v.number() }),
  handler: async (ctx, { deploymentId }) => {
    const assets = await ctx.db
      .query("stagedAssets")
      .withIndex("by_deploymentId", (q) => q.eq("deploymentId", deploymentId))
      .take(MAX_ASSETS_PER_DEPLOYMENT + 1);
    if (assets.length > MAX_ASSETS_PER_DEPLOYMENT) {
      throw new Error(
        `Cannot discard more than ${MAX_ASSETS_PER_DEPLOYMENT} staged files in one transaction`,
      );
    }
    for (const asset of assets) {
      await ctx.db.insert("pendingStorageCleanup", { fileId: asset.fileId });
      await ctx.db.delete("stagedAssets", asset._id);
    }
    return { discarded: assets.length };
  },
});

export const cleanupAbandonedStaging = internalMutation({
  args: { before: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ discarded: v.number(), deletedFiles: v.number() }),
  handler: async (ctx, { before, limit }) => {
    const cutoff = before ?? Date.now() - ABANDONED_UPLOAD_AGE_MS;
    const candidates = await ctx.db
      .query("stagedAssets")
      .order("asc")
      .take(Math.min(limit ?? MAINTENANCE_PAGE_LIMIT, MAINTENANCE_PAGE_LIMIT));
    const assets = candidates.filter((asset) => asset._creationTime < cutoff);
    let deletedFiles = 0;
    for (const asset of assets) {
      await ctx.db.delete("stagedAssets", asset._id);
      if (await deleteUnreferencedFile(ctx, asset.fileId)) deletedFiles++;
    }
    return { discarded: assets.length, deletedFiles };
  },
});

export const cleanupUnreferencedStorage = internalMutation({
  args: { before: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ scanned: v.number(), deleted: v.number(), needsAnotherPass: v.boolean() }),
  handler: async (ctx, { before, limit }) => {
    const state = await ctx.db.query("cleanupState").first();
    const result = await ctx.runMutation(components.files.lib.cleanupUnregistered, {
      before: before ?? Date.now() - ABANDONED_UPLOAD_AGE_MS,
      cursor: state?.fileStorageCleanupCursor,
      limit: Math.min(limit ?? 128, 128),
    });
    if (result.continueCursor === null) {
      if (state) await ctx.db.delete("cleanupState", state._id);
    } else if (state) {
      await ctx.db.patch("cleanupState", state._id, {
        fileStorageCleanupCursor: result.continueCursor,
      });
    } else {
      await ctx.db.insert("cleanupState", { fileStorageCleanupCursor: result.continueCursor });
    }
    return { scanned: result.scanned, deleted: result.deleted, needsAnotherPass: !result.isDone };
  },
});

// Publication switches the manifest in one transaction. File registration and
// deletion stay outside it so a complete 1,800-file deployment fits the budget.
export const publishDeployment = internalMutation({
  args: {
    currentDeploymentId: v.string(),
    expectedAssetCount: v.number(),
    spaFallback: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { currentDeploymentId, expectedAssetCount, spaFallback }) => {
    if (
      !Number.isInteger(expectedAssetCount) ||
      expectedAssetCount < 1 ||
      expectedAssetCount > MAX_ASSETS_PER_DEPLOYMENT
    ) {
      throw new Error(
        `expectedAssetCount must be an integer from 1 to ${MAX_ASSETS_PER_DEPLOYMENT}`,
      );
    }
    const stagedAssets = await ctx.db
      .query("stagedAssets")
      .withIndex("by_deploymentId", (q) => q.eq("deploymentId", currentDeploymentId))
      .take(expectedAssetCount + 1);
    if (stagedAssets.length !== expectedAssetCount) {
      throw new Error(
        `Staged manifest has ${stagedAssets.length} files; expected ${expectedAssetCount}`,
      );
    }
    const assets = stagedAssets.map(({ path, fileId, contentType, deploymentId }) => ({
      path,
      fileId,
      contentType,
      deploymentId,
    }));
    const paths = new Set<string>();
    for (const asset of assets) {
      if (paths.has(asset.path)) throw new Error("Duplicate asset path: " + asset.path);
      paths.add(asset.path);
    }
    if (!paths.has("/index.html"))
      throw new Error("A static asset manifest must include /index.html");
    const manifestBytes = new TextEncoder().encode(JSON.stringify(assets)).byteLength;
    if (manifestBytes > MAX_MANIFEST_SERIALIZED_BYTES) {
      throw new Error(
        `The staged manifest is ${manifestBytes} bytes, above the safe limit of ${MAX_MANIFEST_SERIALIZED_BYTES} bytes. Shorten asset paths or reduce the number of files.`,
      );
    }

    const oldAssets = await ctx.db
      .query("staticAssets")
      .take(MAX_PUBLISH_MANIFEST_READS - assets.length + 1);
    if (assets.length + oldAssets.length > MAX_PUBLISH_MANIFEST_READS) {
      throw new Error(
        `The old and new manifests contain more than ${MAX_PUBLISH_MANIFEST_READS} rows combined.`,
      );
    }
    for (const asset of oldAssets) {
      await ctx.db.delete("staticAssets", asset._id);
      await ctx.db.insert("retiredAssets", {
        path: asset.path,
        fileId: asset.fileId,
        contentType: asset.contentType,
        deploymentId: asset.deploymentId,
        expiresAt: Date.now() + RETIRED_ASSET_AGE_MS,
      });
    }
    for (const asset of assets) {
      await ctx.db.insert("staticAssets", asset);
    }
    for (const asset of stagedAssets) {
      await ctx.db.delete("stagedAssets", asset._id);
    }
    const info = await ctx.db.query("deploymentInfo").first();
    const deployment = {
      currentDeploymentId,
      deployedAt: Date.now(),
      spaFallback: spaFallback ?? true,
    };
    if (info) await ctx.db.patch("deploymentInfo", info._id, deployment);
    else await ctx.db.insert("deploymentInfo", deployment);
    return null;
  },
});
