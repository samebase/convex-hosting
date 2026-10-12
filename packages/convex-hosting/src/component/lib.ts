import { v, type Infer } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { components } from "./_generated/api.js";
import { hasFileExtension, isHtmlContentType } from "./serving.js";

const staticAssetValidator = v.object({
  _id: v.id("staticAssets"),
  _creationTime: v.number(),
  path: v.string(),
  storageId: v.optional(v.id("_storage")),
  fileId: v.optional(v.string()),
  blobId: v.optional(v.string()),
  contentType: v.string(),
  deploymentId: v.string(),
});

const resolvedAssetValidator = v.union(
  staticAssetValidator.extend({ storageUrl: v.optional(v.string()) }),
  staticAssetValidator.omit("_id").extend({
    _id: v.id("retiredAssets"),
    expiresAt: v.number(),
    storageUrl: v.optional(v.string()),
  }),
);

const deploymentInfoValidator = v.object({
  _id: v.id("deploymentInfo"),
  _creationTime: v.number(),
  currentDeploymentId: v.string(),
  deployedAt: v.number(),
  spaFallback: v.optional(v.boolean()),
  pendingBlobCleanupCount: v.optional(v.number()),
});

const MAX_ASSETS_PER_DEPLOYMENT = 1800;
const MAX_PUBLISH_MANIFEST_READS = 3800;
const MAX_PUBLISH_DOCUMENT_WRITES = 15500;
const MAX_MANIFEST_SERIALIZED_BYTES = 2 * 1024 * 1024;
const MAINTENANCE_PAGE_LIMIT = 256;
// Reserve reads for the nested files component's bounded orphan scan.
const STORAGE_SCAN_LIMIT = 1600;
const ABANDONED_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;
const RETIRED_ASSET_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const httpAssetValidator = v.object({
  storageUrl: v.optional(v.string()),
  blobId: v.optional(v.string()),
  contentType: v.string(),
  etag: v.optional(v.string()),
  // TODO(remove in a future major): v1→v2 transitional only. Set when an
  // inherited v1 row points at app-owned storage the component can't read, so
  // the app-side `registerStaticRoutes` handler can serve it from its own
  // storage during migration. Drop this field once v1 app-storage assets are
  // no longer supported.
  appStorageId: v.optional(v.string()),
});

async function resolveAssetDocument(
  ctx: QueryCtx,
  path: string,
  spaFallbackOverride?: boolean,
): Promise<Infer<typeof resolvedAssetValidator> | null> {
  const exact = await ctx.db
    .query("staticAssets")
    .withIndex("by_path", (q) => q.eq("path", path))
    .unique();
  if (exact) return exact;

  if (hasFileExtension(path)) {
    // A file the current deployment replaced stays reachable for a while, so
    // pages that are already open can still load their scripts. Old HTML never
    // comes back.
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

async function deleteStorageFile(ctx: MutationCtx, storageId: Id<"_storage">) {
  const retiredReference = await ctx.db
    .query("retiredAssets")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  if (retiredReference) return false;
  // A v2 component mounted with the old `selfHosting` name can inherit v1 rows
  // containing app-owned storage IDs. They are deliberately invisible in the
  // component namespace. Checking metadata avoids relying on backend error text
  // and treats both those foreign IDs and already-deleted files as absent.
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (metadata === null) return false;

  await ctx.storage.delete(storageId);
  return true;
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

async function adjustPendingBlobCleanupCount(ctx: MutationCtx, delta: number): Promise<number> {
  const state = await ctx.db.query("cleanupState").first();
  if (state) {
    const next = Math.max(0, state.pendingBlobCleanupCount + delta);
    await ctx.db.patch("cleanupState", state._id, {
      pendingBlobCleanupCount: next,
    });
    return next;
  }

  // Seed upgrades from the old denormalized field when present. On a fresh
  // install this also works before deploymentInfo exists.
  const info = await ctx.db.query("deploymentInfo").first();
  const next = Math.max(0, (info?.pendingBlobCleanupCount ?? 0) + delta);
  await ctx.db.insert("cleanupState", { pendingBlobCleanupCount: next });
  return next;
}

export const getCurrentDeployment = query({
  args: {},
  returns: v.union(deploymentInfoValidator, v.null()),
  handler: async (ctx) => {
    const info = await ctx.db.query("deploymentInfo").first();
    if (!info) return null;
    const state = await ctx.db.query("cleanupState").first();
    return {
      ...info,
      pendingBlobCleanupCount: state?.pendingBlobCleanupCount ?? info.pendingBlobCleanupCount,
    };
  },
});

// Narrow serving API used by the app-owned `registerStaticRoutes` compatibility
// mode. The app can resolve a public asset, but all storage and deployment
// management stays encapsulated in the component.
export const resolveAssetForHttp = query({
  args: {
    path: v.string(),
    spaFallback: v.optional(v.boolean()),
  },
  returns: v.union(httpAssetValidator, v.null()),
  handler: async (ctx, { path, spaFallback }) => {
    const asset = await resolveAssetDocument(ctx, path, spaFallback);
    if (!asset) return null;

    if (asset.fileId) {
      const file = await ctx.runQuery(components.files.lib.get, { fileId: asset.fileId });
      return {
        ...(file?.url ? { storageUrl: file.url } : {}),
        contentType: asset.contentType,
        etag: `"${asset.fileId}"`,
      };
    }

    const storageUrl = asset.storageId ? await ctx.storage.getUrl(asset.storageId) : null;

    // TODO(remove in a future major): v1→v2 transitional path. During a
    // same-name migration, inherited v1 rows point at app-owned storage the
    // component can't fetch (storageId present but no resolvable URL and no
    // blob). Rather than hide them (which shows the setup page until the first
    // v2 upload), surface the raw storage id so the app-side
    // `registerStaticRoutes` handler can serve the file from its own storage —
    // keeping the live site up with zero downtime and no re-upload. The
    // component-owned HTTP handler still can't reach app storage, so it
    // continues to show its setup page for this case. Once v1 app-storage
    // assets are no longer supported, delete `appStorageId` and return null
    // here instead.
    const appStorageId =
      asset.storageId && !storageUrl && !asset.blobId ? asset.storageId : undefined;

    return {
      ...(storageUrl ? { storageUrl } : {}),
      ...(appStorageId ? { appStorageId } : {}),
      ...(asset.blobId ? { blobId: asset.blobId } : {}),
      contentType: asset.contentType,
      ...(asset.storageId ? { etag: `"${asset.storageId}"` } : {}),
    };
  },
});

// Returns the deployment URLs visible to this component:
//   siteUrl  - CONVEX_SITE_URL (includes the component's mount prefix). Used
//              by the CLI to derive CONVEX_HOSTING_BASE_PATH and to show
//              where the deployed app lives.
//   cloudUrl - CONVEX_CLOUD_URL. Used by the CLI as VITE_CONVEX_URL when
//              building the frontend.
export const getUrls = internalQuery({
  args: {},
  returns: v.object({
    siteUrl: v.string(),
    cloudUrl: v.string(),
  }),
  handler: async () => ({
    siteUrl: process.env.CONVEX_SITE_URL!,
    cloudUrl: process.env.CONVEX_CLOUD_URL!,
  }),
});

export const getByPath = internalQuery({
  args: { path: v.string() },
  returns: v.union(staticAssetValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("staticAssets")
      .withIndex("by_path", (q) => q.eq("path", args.path))
      .unique();
  },
});

// Resolves the asset the HTTP handler should serve for a request path: the
// exact match, or, when SPA fallback is enabled for the current deployment
// and the path looks like a client-side route (no file extension), the
// index.html asset. Doing the fallback here keeps it to a single query.
export const resolveAsset = internalQuery({
  args: { path: v.string() },
  returns: v.union(resolvedAssetValidator, v.null()),
  handler: async (ctx, { path }) => {
    const asset = await resolveAssetDocument(ctx, path);
    if (!asset?.fileId) return asset;
    const file = await ctx.runQuery(components.files.lib.get, { fileId: asset.fileId });
    return { ...asset, ...(file?.url ? { storageUrl: file.url } : {}) };
  },
});

export const listAssets = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(staticAssetValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("staticAssets")
      .order("asc")
      .take(args.limit ?? 100);
  },
});

export const generateUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.runMutation(components.files.lib.generateUploadUrl, {});
  },
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

export const listPendingBlobCleanup = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.string()),
  handler: async (ctx, { limit }) => {
    return (await ctx.db.query("pendingBlobCleanup").take(Math.min(limit ?? 250, 500))).map(
      (entry) => entry.blobId,
    );
  },
});

export const acknowledgeBlobCleanup = internalMutation({
  args: { blobIds: v.array(v.string()) },
  returns: v.object({ acknowledged: v.number() }),
  handler: async (ctx, { blobIds }) => {
    let acknowledged = 0;
    for (const blobId of new Set(blobIds)) {
      const entries = await ctx.db
        .query("pendingBlobCleanup")
        .withIndex("by_blobId", (q) => q.eq("blobId", blobId))
        .collect();
      for (const entry of entries) {
        await ctx.db.delete("pendingBlobCleanup", entry._id);
        acknowledged++;
      }
    }

    if (acknowledged > 0) {
      await adjustPendingBlobCleanupCount(ctx, -acknowledged);
    }
    return { acknowledged };
  },
});

export const queueBlobCleanup = internalMutation({
  args: { blobIds: v.array(v.string()) },
  returns: v.object({ queued: v.number() }),
  handler: async (ctx, { blobIds }) => {
    let queued = 0;
    for (const blobId of new Set(blobIds)) {
      const existing = await ctx.db
        .query("pendingBlobCleanup")
        .withIndex("by_blobId", (q) => q.eq("blobId", blobId))
        .first();
      if (existing) continue;
      await ctx.db.insert("pendingBlobCleanup", { blobId });
      queued++;
    }

    if (queued > 0) await adjustPendingBlobCleanupCount(ctx, queued);
    return { queued };
  },
});

export const cleanupPendingStorage = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    processed: v.number(),
    deleted: v.number(),
    needsAnotherPass: v.boolean(),
  }),
  handler: async (ctx, { limit }) => {
    const batchLimit = Math.min(limit ?? MAINTENANCE_PAGE_LIMIT, MAINTENANCE_PAGE_LIMIT);
    const expired = await ctx.db
      .query("retiredAssets")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(batchLimit);
    for (const asset of expired) {
      await ctx.db.insert("pendingStorageCleanup", {
        ...(asset.storageId ? { storageId: asset.storageId } : {}),
        ...(asset.fileId ? { fileId: asset.fileId } : {}),
      });
      await ctx.db.delete("retiredAssets", asset._id);
    }
    const entries = await ctx.db.query("pendingStorageCleanup").take(batchLimit);
    let deleted = 0;
    for (const entry of entries) {
      if (entry.fileId) {
        if (await deleteUnreferencedFile(ctx, entry.fileId)) deleted++;
      } else if (entry.storageId) {
        const [liveReference, stagedReference] = await Promise.all([
          ctx.db
            .query("staticAssets")
            .withIndex("by_storageId", (q) => q.eq("storageId", entry.storageId))
            .first(),
          ctx.db
            .query("stagedAssets")
            .withIndex("by_storageId", (q) => q.eq("storageId", entry.storageId))
            .first(),
        ]);
        if (!liveReference && !stagedReference && (await deleteStorageFile(ctx, entry.storageId))) {
          deleted++;
        }
      }
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
  args: {
    storageIds: v.optional(v.array(v.id("_storage"))),
    fileStorageIds: v.optional(v.array(v.string())),
  },
  returns: v.object({
    deleted: v.number(),
    alreadyMissing: v.number(),
    stillReferenced: v.number(),
  }),
  handler: async (ctx, { storageIds, fileStorageIds }) => {
    // A publish can commit even if the CLI loses its response. Never delete a
    // file that the live manifest now references during failure cleanup.
    const liveAssets = storageIds?.length ? await ctx.db.query("staticAssets").collect() : [];
    const referencedStorageIds = new Set(
      liveAssets.flatMap((asset) => (asset.storageId === undefined ? [] : [asset.storageId])),
    );
    let deleted = 0;
    let alreadyMissing = 0;
    let stillReferenced = 0;
    for (const storageId of storageIds ?? []) {
      const retiredReference = await ctx.db
        .query("retiredAssets")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
        .first();
      if (referencedStorageIds.has(storageId) || retiredReference) {
        stillReferenced++;
        continue;
      }
      if (await deleteStorageFile(ctx, storageId)) {
        deleted++;
      } else {
        alreadyMissing++;
      }
    }
    for (const storageId of fileStorageIds ?? []) {
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

const recordAssetFields = {
  path: v.string(),
  storageId: v.optional(v.id("_storage")),
  blobId: v.optional(v.string()),
  contentType: v.string(),
  deploymentId: v.string(),
};

function assertAssetLocation({
  path,
  storageId,
  blobId,
  fileId,
  fileStorageId,
}: {
  path: string;
  storageId?: Id<"_storage">;
  blobId?: string;
  fileId?: string;
  fileStorageId?: string;
}) {
  if (
    [storageId, blobId, fileId, fileStorageId].filter((location) => location !== undefined)
      .length !== 1
  ) {
    throw new Error("Asset " + path + " must have exactly one storage location");
  }
}

function assertAssetManifest(
  assets: Array<{
    path: string;
    storageId?: Id<"_storage">;
    blobId?: string;
    fileId?: string;
    deploymentId: string;
  }>,
  deploymentId?: string,
  requireIndex = false,
) {
  if (requireIndex && assets.length === 0) {
    throw new Error("A static asset manifest cannot be empty");
  }
  if (requireIndex && assets.length > MAX_ASSETS_PER_DEPLOYMENT) {
    throw new Error(
      `A static asset manifest can contain at most ${MAX_ASSETS_PER_DEPLOYMENT} files`,
    );
  }

  const paths = new Set<string>();
  for (const asset of assets) {
    assertAssetLocation(asset);
    if (paths.has(asset.path)) {
      throw new Error("Duplicate asset path: " + asset.path);
    }
    if (deploymentId !== undefined && asset.deploymentId !== deploymentId) {
      throw new Error("Asset " + asset.path + " has the wrong deploymentId");
    }
    paths.add(asset.path);
  }

  if (requireIndex && !paths.has("/index.html")) {
    throw new Error("A static asset manifest must include /index.html");
  }
}

export const stageAssets = internalMutation({
  args: {
    assets: v.array(v.object({ ...recordAssetFields, fileStorageId: v.optional(v.string()) })),
  },
  returns: v.object({ staged: v.number() }),
  handler: async (ctx, { assets }) => {
    if (assets.length === 0) {
      throw new Error("Cannot stage an empty asset chunk");
    }
    if (assets.filter((asset) => asset.fileStorageId !== undefined).length > 100) {
      throw new Error("A staged chunk can register at most 100 files");
    }

    // Validate locations and deployment IDs within this chunk now. Duplicate
    // paths across chunks are checked again when the full manifest publishes.
    const deploymentId = assets[0].deploymentId;
    for (const asset of assets) {
      assertAssetLocation(asset);
      if (asset.deploymentId !== deploymentId) {
        throw new Error("A staged asset chunk must use one deploymentId");
      }
      if (asset.fileStorageId !== undefined) {
        if (!asset.path.startsWith("/") || deploymentId === "" || deploymentId.includes("/")) {
          throw new Error(
            "A file asset needs an absolute URL path and a deployment ID without slashes",
          );
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
        continue;
      }
      // Validate component-storage IDs while the manifest is still split into
      // small CLI chunks. Doing this for the complete manifest during publish
      // would exceed Convex's index-range-read limit on large deployments.
      if (asset.storageId && (await ctx.db.system.get("_storage", asset.storageId)) === null) {
        throw new Error(`Staged storage file is missing for ${asset.path}`);
      }
      await ctx.db.insert("stagedAssets", {
        path: asset.path,
        ...(asset.storageId ? { storageId: asset.storageId } : {}),
        ...(asset.blobId ? { blobId: asset.blobId } : {}),
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
      .collect();
    for (const asset of assets) {
      if (asset.fileId) {
        await ctx.db.insert("pendingStorageCleanup", { fileId: asset.fileId });
      }
      await ctx.db.delete("stagedAssets", asset._id);
    }
    return { discarded: assets.length };
  },
});

export const cleanupAbandonedStaging = internalMutation({
  args: {
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    discarded: v.number(),
    deletedFiles: v.number(),
    queuedBlobIds: v.number(),
  }),
  handler: async (ctx, { before, limit }) => {
    const cutoff = before ?? Date.now() - ABANDONED_UPLOAD_AGE_MS;
    const candidates = await ctx.db
      .query("stagedAssets")
      .order("asc")
      .take(Math.min(limit ?? MAINTENANCE_PAGE_LIMIT, MAINTENANCE_PAGE_LIMIT));
    const assets = candidates.filter((asset) => asset._creationTime < cutoff);
    let deletedFiles = 0;
    let queuedBlobIds = 0;
    for (const asset of assets) {
      await ctx.db.delete("stagedAssets", asset._id);
      if (asset.fileId && (await deleteUnreferencedFile(ctx, asset.fileId))) {
        deletedFiles++;
      }
      if (asset.storageId) {
        const liveReference = await ctx.db
          .query("staticAssets")
          .withIndex("by_storageId", (q) => q.eq("storageId", asset.storageId))
          .first();
        if (!liveReference && (await deleteStorageFile(ctx, asset.storageId))) {
          deletedFiles++;
        }
      }
      if (asset.blobId) {
        await ctx.db.insert("pendingBlobCleanup", { blobId: asset.blobId });
        queuedBlobIds++;
      }
    }

    if (queuedBlobIds > 0) {
      await adjustPendingBlobCleanupCount(ctx, queuedBlobIds);
    }
    return {
      discarded: assets.length,
      deletedFiles,
      queuedBlobIds,
    };
  },
});

export const cleanupUnreferencedStorage = internalMutation({
  args: {
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: v.object({
    scanned: v.number(),
    deleted: v.number(),
    needsAnotherPass: v.boolean(),
  }),
  handler: async (ctx, { before, limit, order }) => {
    const cutoff = before ?? Date.now() - ABANDONED_UPLOAD_AGE_MS;
    const scanOrder = order ?? "asc";
    // Reserve at most 257 document reads for a child page: 129 storage rows
    // and 128 registration checks. The legacy scan stays below 3,600 reads.
    const files = await ctx.db.system.query("_storage").order(scanOrder).take(STORAGE_SCAN_LIMIT);
    const liveAssets = files.length > 0 ? await ctx.db.query("staticAssets").collect() : [];
    const liveStorageIds = new Set(
      liveAssets.flatMap((asset) => (asset.storageId === undefined ? [] : [asset.storageId])),
    );
    const stagedLookupBudget = Math.max(0, 3600 - liveAssets.length - files.length);
    const deleteLimit = Math.min(limit ?? MAINTENANCE_PAGE_LIMIT, MAINTENANCE_PAGE_LIMIT);
    let deleted = 0;
    let scanned = 0;
    let stagedLookups = 0;
    let stoppedForReadBudget = false;
    for (const file of files) {
      if (deleted >= deleteLimit) break;
      if (file._creationTime >= cutoff) {
        if (scanOrder === "asc") break;
        continue;
      }
      scanned++;
      if (liveStorageIds.has(file._id)) continue;
      if (stagedLookups + 2 > stagedLookupBudget) {
        stoppedForReadBudget = true;
        break;
      }
      stagedLookups += 2;
      const stagedReference = await ctx.db
        .query("stagedAssets")
        .withIndex("by_storageId", (q) => q.eq("storageId", file._id))
        .first();
      const retiredReference = await ctx.db
        .query("retiredAssets")
        .withIndex("by_storageId", (q) => q.eq("storageId", file._id))
        .first();
      if (!stagedReference && !retiredReference) {
        await ctx.storage.delete(file._id);
        deleted++;
      }
    }
    let needsAnotherPass =
      deleted === deleteLimit ||
      // Without deletes, another legacy pass would inspect the same protected prefix.
      (deleted > 0 && (stoppedForReadBudget || files.length === STORAGE_SCAN_LIMIT));
    // The CLI scans legacy storage in both directions. The child uses its own
    // persistent ID cursor and needs only one sweep.
    if (scanOrder === "asc" && deleted < deleteLimit) {
      const state = await ctx.db.query("cleanupState").first();
      const result = await ctx.runMutation(components.files.lib.cleanupUnregistered, {
        before: Math.min(cutoff, Date.now()),
        cursor: state?.fileStorageCleanupCursor,
        limit: Math.min(128, deleteLimit - deleted),
      });
      const nextCursor = result.continueCursor ?? undefined;
      if (nextCursor !== state?.fileStorageCleanupCursor) {
        if (state) {
          await ctx.db.patch("cleanupState", state._id, { fileStorageCleanupCursor: nextCursor });
        } else {
          const info = await ctx.db.query("deploymentInfo").first();
          await ctx.db.insert("cleanupState", {
            pendingBlobCleanupCount: info?.pendingBlobCleanupCount ?? 0,
            fileStorageCleanupCursor: nextCursor,
          });
        }
      }
      scanned += result.scanned;
      deleted += result.deleted;
      needsAnotherPass ||= !result.isDone;
    }
    return { scanned, deleted, needsAnotherPass };
  },
});

async function setCurrentDeployment(
  ctx: MutationCtx,
  currentDeploymentId: string,
  spaFallback: boolean,
  pendingBlobCleanupCount?: number,
) {
  const existing = await ctx.db.query("deploymentInfo").first();
  if (existing) {
    await ctx.db.patch("deploymentInfo", existing._id, {
      currentDeploymentId,
      deployedAt: Date.now(),
      spaFallback,
      ...(pendingBlobCleanupCount === undefined ? {} : { pendingBlobCleanupCount }),
    });
  } else {
    await ctx.db.insert("deploymentInfo", {
      currentDeploymentId,
      deployedAt: Date.now(),
      spaFallback,
      ...(pendingBlobCleanupCount === undefined ? {} : { pendingBlobCleanupCount }),
    });
  }
}

export const recordAsset = internalMutation({
  args: recordAssetFields,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    assertAssetLocation(args);
    const existing = await ctx.db
      .query("staticAssets")
      .withIndex("by_path", (q) => q.eq("path", args.path))
      .unique();
    if (existing) {
      if (existing.storageId) {
        await deleteStorageFile(ctx, existing.storageId);
      }
      if (existing.fileId) {
        await ctx.db.insert("pendingStorageCleanup", { fileId: existing.fileId });
      }
      await ctx.db.delete("staticAssets", existing._id);
    }
    await ctx.db.insert("staticAssets", {
      path: args.path,
      ...(args.storageId ? { storageId: args.storageId } : {}),
      ...(args.blobId ? { blobId: args.blobId } : {}),
      contentType: args.contentType,
      deploymentId: args.deploymentId,
    });
    return existing?.blobId ?? null;
  },
});

export const recordAssets = internalMutation({
  args: { assets: v.array(v.object(recordAssetFields)) },
  returns: v.object({ blobIds: v.array(v.string()) }),
  handler: async (ctx, { assets }) => {
    assertAssetManifest(assets);

    const blobIds: string[] = [];
    for (const asset of assets) {
      const existing = await ctx.db
        .query("staticAssets")
        .withIndex("by_path", (q) => q.eq("path", asset.path))
        .unique();
      if (existing) {
        if (existing.storageId) {
          await deleteStorageFile(ctx, existing.storageId);
        }
        if (existing.fileId) {
          await ctx.db.insert("pendingStorageCleanup", { fileId: existing.fileId });
        }
        if (existing.blobId) {
          blobIds.push(existing.blobId);
        }
        await ctx.db.delete("staticAssets", existing._id);
      }
      await ctx.db.insert("staticAssets", {
        path: asset.path,
        ...(asset.storageId ? { storageId: asset.storageId } : {}),
        ...(asset.blobId ? { blobId: asset.blobId } : {}),
        contentType: asset.contentType,
        deploymentId: asset.deploymentId,
      });
    }
    return { blobIds };
  },
});

// Publish the complete manifest, deployment metadata, and old-asset cleanup in
// one mutation. Until this succeeds, the previous deployment remains wholly
// live. Failure cleanup separately checks the live manifest before deleting
// newly uploaded files in case this mutation committed but its response was
// lost.
export const publishDeployment = internalMutation({
  args: {
    currentDeploymentId: v.string(),
    expectedAssetCount: v.number(),
    spaFallback: v.optional(v.boolean()),
  },
  returns: v.object({
    deleted: v.number(),
    pendingBlobCleanup: v.number(),
  }),
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
    const assets = stagedAssets.map(
      ({ path, storageId, fileId, blobId, contentType, deploymentId }) => ({
        path,
        storageId,
        fileId,
        blobId,
        contentType,
        deploymentId,
      }),
    );
    if (assets.length !== expectedAssetCount) {
      throw new Error(`Staged manifest has ${assets.length} files; expected ${expectedAssetCount}`);
    }
    assertAssetManifest(assets, currentDeploymentId, true);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(assets)).byteLength;
    if (manifestBytes > MAX_MANIFEST_SERIALIZED_BYTES) {
      throw new Error(
        `The staged manifest is ${manifestBytes} bytes, above the safe limit of ${MAX_MANIFEST_SERIALIZED_BYTES} bytes. Shorten asset paths or reduce the number of files.`,
      );
    }

    // Leave headroom below Convex's 4,096 document-read ceiling for deployment
    // metadata and index bookkeeping. Taking one extra old row lets oversized
    // v1-to-v2 migrations fail clearly instead of exceeding the platform limit.
    const oldAssetReadLimit = MAX_PUBLISH_MANIFEST_READS - assets.length + 1;
    const oldAssets = await ctx.db.query("staticAssets").take(oldAssetReadLimit);
    if (assets.length + oldAssets.length > MAX_PUBLISH_MANIFEST_READS) {
      throw new Error(
        `The old and new manifests contain more than ${MAX_PUBLISH_MANIFEST_READS} rows combined. Reduce the new build or clean up the legacy manifest before migrating.`,
      );
    }
    const retiredAssets = oldAssets.flatMap((asset) => {
      if (
        (asset.storageId !== undefined || asset.fileId !== undefined) &&
        asset.blobId === undefined
      ) {
        return [
          {
            _id: asset._id,
            path: asset.path,
            ...(asset.storageId ? { storageId: asset.storageId } : {}),
            ...(asset.fileId ? { fileId: asset.fileId } : {}),
            contentType: asset.contentType,
            deploymentId: asset.deploymentId,
          },
        ];
      }
      return [];
    });
    const retiredIds = new Set(retiredAssets.map((asset) => asset._id));
    const blobIds: string[] = [];
    const storageIds = new Set<Id<"_storage">>();
    const fileIds = new Set<string>();
    for (const asset of oldAssets) {
      if (retiredIds.has(asset._id)) continue;
      if (asset.blobId) blobIds.push(asset.blobId);
      if (asset.storageId) storageIds.add(asset.storageId);
      if (asset.fileId) fileIds.add(asset.fileId);
    }
    const plannedDocumentWrites =
      oldAssets.length +
      storageIds.size +
      fileIds.size +
      blobIds.length +
      assets.length +
      stagedAssets.length +
      retiredAssets.length +
      2;
    if (plannedDocumentWrites > MAX_PUBLISH_DOCUMENT_WRITES) {
      throw new Error(
        `Publishing this manifest would require ${plannedDocumentWrites} document writes, above the safe limit of ${MAX_PUBLISH_DOCUMENT_WRITES}. Reduce the number of files in the deployment.`,
      );
    }

    for (const asset of oldAssets) {
      await ctx.db.delete("staticAssets", asset._id);
    }

    for (const { _id, ...asset } of retiredAssets) {
      await ctx.db.insert("retiredAssets", {
        ...asset,
        expiresAt: Date.now() + RETIRED_ASSET_AGE_MS,
      });
    }

    for (const asset of assets) {
      await ctx.db.insert("staticAssets", {
        path: asset.path,
        ...(asset.storageId ? { storageId: asset.storageId } : {}),
        ...(asset.fileId ? { fileId: asset.fileId } : {}),
        ...(asset.blobId ? { blobId: asset.blobId } : {}),
        contentType: asset.contentType,
        deploymentId: asset.deploymentId,
      });
    }

    for (const asset of stagedAssets) {
      await ctx.db.delete("stagedAssets", asset._id);
    }

    for (const blobId of blobIds) {
      await ctx.db.insert("pendingBlobCleanup", { blobId });
    }
    for (const storageId of storageIds) {
      await ctx.db.insert("pendingStorageCleanup", { storageId });
    }
    for (const fileId of fileIds) {
      await ctx.db.insert("pendingStorageCleanup", { fileId });
    }

    const pendingBlobCleanup = await adjustPendingBlobCleanupCount(ctx, blobIds.length);
    await setCurrentDeployment(ctx, currentDeploymentId, spaFallback ?? true, pendingBlobCleanup);
    // Old component-storage objects are collected in a separate bounded
    // maintenance mutation. Keeping those deletes out of this transaction is
    // what lets a 1,800-file manifest switch atomically below Convex's read
    // and write limits.
    return { deleted: 0, pendingBlobCleanup };
  },
});

// Commits a finished upload as the current deployment: records the deployment
// id + SPA config, then garbage-collects assets left over from previous
// deployments. Returns the storage cleanup tally plus any CDN blobIds the
// caller should delete (component actions can't reach the /fs blobs endpoint).
export const commitDeployment = internalMutation({
  args: {
    currentDeploymentId: v.string(),
    // Whether to serve SPA fallback for this deployment (default true).
    spaFallback: v.optional(v.boolean()),
  },
  returns: v.object({
    deleted: v.number(),
    blobIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const oldAssets = await ctx.db.query("staticAssets").collect();
    const blobIds: string[] = [];
    let deleted = 0;
    for (const asset of oldAssets) {
      if (asset.deploymentId === args.currentDeploymentId) continue;
      if (asset.storageId) {
        if (await deleteStorageFile(ctx, asset.storageId)) {
          deleted++;
        }
      }
      if (asset.fileId) {
        await ctx.db.insert("pendingStorageCleanup", { fileId: asset.fileId });
      }
      if (asset.blobId) {
        blobIds.push(asset.blobId);
      }
      await ctx.db.delete("staticAssets", asset._id);
    }

    await setCurrentDeployment(ctx, args.currentDeploymentId, args.spaFallback ?? true);
    return { deleted, blobIds };
  },
});
