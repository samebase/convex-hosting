import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { Analytics } from "../workers-shared/asset-worker/src/analytics.js";
import { normalizeConfiguration } from "../workers-shared/asset-worker/src/configuration.js";
import { canFetch, handleRequest } from "../workers-shared/asset-worker/src/handler.js";
import { mockJaegerBinding } from "../workers-shared/utils/tracing.js";
import { AssetConfigSchema } from "../workers-shared/utils/types.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server.js";

/**
 * The compatibility date of Cloudflare's handler. From 2025-04-01 on, Cloudflare applies
 * `not_found_handling` to a request with `Sec-Fetch-Mode: navigate` when a Worker exists.
 */
const COMPATIBILITY_DATE = "2025-04-01";

/**
 * A version that never became live, and a stored file that no entry references, are garbage once
 * they are a day old: a failed deploy leaves them, and an upload in progress is younger. This age
 * bounds the garbage of failed deploys; it decides nothing about what is served.
 */
const GARBAGE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Entries that one `collect` call deletes. Each entry reads one index range (`by_storageId`) of at
 * most one document, and deletes the entry and at most one stored file. With the scan of
 * `versions` and the range of the version's entries, 1,000 entries are 1,002 index ranges of 4,096,
 * 2,000 documents read of 32,000 besides the versions, and at most 2,002 writes of 16,000 with the
 * version and the next call. Entries below 4 KiB read at most 8 MiB with their lookups, which leaves
 * 8 MiB of the 16 MiB read limit for the version documents that the call reads to find the newest
 * live one: the live versions and the versions of the last day that never became live. That is
 * eight versions at the largest config the CLI allows (900 KiB), and hundreds at a config of a few
 * KiB.
 */
const DELETE_BATCH = 1000;

/**
 * `_storage` documents that one `collect` call reads. Each one reads one index range
 * (`by_storageId`) of at most one entry and may delete the file: 1,000 files are 1,000 index ranges,
 * at most 2,000 documents read, and 1,000 writes.
 */
const SWEEP_BATCH = 1000;

/**
 * The file that `upload` stores and `createVersion` reads: Cloudflare's `AssetConfig` for the
 * version, without the fields that are package code.
 */
const configSchema = AssetConfigSchema.pick({
  html_handling: true,
  not_found_handling: true,
  headers: true,
  redirects: true,
});

export type Config = z.input<typeof configSchema>;

async function getVersion(ctx: QueryCtx, versionId: string) {
  return await ctx.db
    .query("versions")
    .withIndex("by_versionId", (q) => q.eq("versionId", versionId))
    .unique();
}

async function getEntry(ctx: QueryCtx, versionId: string, path: string) {
  return await ctx.db
    .query("entries")
    .withIndex("by_version_path", (q) => q.eq("versionId", versionId).eq("path", path))
    .unique();
}

async function getVersionOrThrow(ctx: QueryCtx, versionId: string) {
  const version = await getVersion(ctx, versionId);
  if (version === null) throw new ConvexError(`Version ${versionId} does not exist.`);
  return version;
}

async function isUnreferenced(ctx: QueryCtx, storageId: Id<"_storage">) {
  const entry = await ctx.db
    .query("entries")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  return entry === null;
}

export const generateUploadUrls = internalMutation({
  args: { count: v.number() },
  returns: v.array(v.string()),
  handler: async (ctx, { count }) =>
    await Promise.all(Array.from({ length: count }, () => ctx.storage.generateUploadUrl())),
});

/**
 * Starts a version: reads its config from storage and creates the version in state `uploading`.
 * Idempotent for the same id and config.
 */
export const createVersion = internalAction({
  args: { versionId: v.string(), configId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { versionId, configId }) => {
    const blob = await ctx.storage.get(configId);
    if (blob === null) throw new ConvexError(`The config ${configId} is not in storage.`);
    const config = configSchema.parse(JSON.parse(await blob.text()));
    await ctx.runMutation(internal.lib.insertVersion, {
      versionId,
      config: JSON.stringify(config),
    });
    return null;
  },
});

/** The write of `createVersion`: creates the version, unless it exists with the same config. */
export const insertVersion = internalMutation({
  args: { versionId: v.string(), config: v.string() },
  returns: v.null(),
  handler: async (ctx, { versionId, config }) => {
    const version = await getVersion(ctx, versionId);
    if (version === null) {
      await ctx.db.insert("versions", { versionId, state: { kind: "uploading" }, config });
    } else if (version.config !== config) {
      throw new ConvexError(`Version ${versionId} exists with a different config.`);
    }
    return null;
  },
});

/**
 * The stored file of each hash that an entry of any version already has, in the order of
 * `sha256s`.
 *
 * Each hash reads one index range (`by_sha256`) of at most one document. The CLI sends at most
 * 8,000 characters of arguments, which hold at most 119 hashes of 67 characters: 119 index ranges
 * of 4,096 and 119 documents read of 32,000.
 */
export const knownFiles = internalQuery({
  args: { sha256s: v.array(v.string()) },
  returns: v.array(v.object({ sha256: v.string(), storageId: v.id("_storage") })),
  handler: async (ctx, { sha256s }) => {
    const known: { sha256: string; storageId: Id<"_storage"> }[] = [];
    for (const sha256 of sha256s) {
      const entry = await ctx.db
        .query("entries")
        .withIndex("by_sha256", (q) => q.eq("sha256", sha256))
        .first();
      if (entry !== null) known.push({ sha256, storageId: entry.storageId });
    }
    return known;
  },
});

/**
 * Inserts complete entries into an `uploading` version, after checking that each stored file has
 * the entry's sha256. An entry that exists with the same sha256 is skipped, so a retried batch
 * passes; one that exists with another sha256 is refused.
 *
 * Each entry reads one index range (`by_version_path`) of at most one document and one `_storage`
 * document, and writes at most one document. The CLI sends at most 8,000 characters of arguments,
 * and an entry takes at least 135 of them (its sha256 and storage id alone are 96), so a call has
 * at most 60 entries: 60 index ranges of 4,096, at most 121 documents read of 32,000 with the
 * version, and 60 writes of 16,000.
 */
export const recordFiles = internalMutation({
  args: {
    versionId: v.string(),
    entries: v.array(
      v.object({
        path: v.string(),
        sha256: v.string(),
        contentType: v.optional(v.string()),
        storageId: v.id("_storage"),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { versionId, entries }) => {
    const version = await getVersionOrThrow(ctx, versionId);
    if (version.state.kind !== "uploading") {
      throw new ConvexError(`Version ${versionId} is ${version.state.kind}, not uploading.`);
    }
    for (const entry of entries) {
      const existing = await getEntry(ctx, versionId, entry.path);
      if (existing !== null) {
        if (existing.sha256 !== entry.sha256) {
          throw new ConvexError(`Version ${versionId} has other contents at ${entry.path}.`);
        }
        continue;
      }
      const stored = await ctx.db.system.get("_storage", entry.storageId);
      if (stored === null || base64ToHex(stored.sha256) !== entry.sha256) {
        throw new ConvexError(`The file stored for ${entry.path} does not match its sha256.`);
      }
      await ctx.db.insert("entries", {
        versionId,
        path: entry.path,
        sha256: entry.sha256,
        contentType: entry.contentType,
        storageId: entry.storageId,
      });
    }
    return null;
  },
});

/**
 * Marks an `uploading` version `ready`. The CLI calls it after every `recordFiles` batch succeeded.
 * A version that is already `ready` or `live` stays as it is.
 */
export const finishVersion = internalMutation({
  args: { versionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { versionId }) => {
    const version = await getVersionOrThrow(ctx, versionId);
    if (version.state.kind === "uploading") {
      await ctx.db.patch("versions", version._id, { state: { kind: "ready" } });
    }
    return null;
  },
});

/**
 * Marks a `ready` version `live` and schedules `collect`. `serveAsset` calls it at the first
 * request that the version's pushed code serves; a version that is already live stays as it is, so
 * concurrent first requests are fine.
 */
export const markLive = mutation({
  args: { versionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { versionId }) => {
    const version = await getVersionOrThrow(ctx, versionId);
    if (version.state.kind === "live") return null;
    if (version.state.kind === "uploading") {
      throw new ConvexError(`Version ${versionId} is still uploading.`);
    }
    await ctx.db.patch("versions", version._id, { state: { kind: "live", at: Date.now() } });
    await ctx.scheduler.runAfter(0, internal.lib.collect, {});
    return null;
  },
});

/**
 * Deletes, one batch per call, scheduling itself with `runAfter(0)` while work remains: the live
 * versions older than the newest live one, whose code is gone because the newest one has served
 * since; the versions that are not live and older than `GARBAGE_AGE_MS`; their entries and the
 * stored files that no remaining entry uses; then the `_storage` files that no entry references and
 * that are older than `GARBAGE_AGE_MS`.
 */
export const collect = internalMutation({
  args: {
    /** The `_creationTime` of the last `_storage` file that the previous batch read. */
    storageCursor: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { storageCursor }) => {
    const garbageBefore = Date.now() - GARBAGE_AGE_MS;

    if (storageCursor === undefined) {
      const versions = await ctx.db.query("versions").collect();
      let newestLiveAt = -Infinity;
      for (const { state } of versions) {
        if (state.kind === "live") newestLiveAt = Math.max(newestLiveAt, state.at);
      }
      const garbage = versions.find(({ state, _creationTime }) =>
        state.kind === "live" ? state.at < newestLiveAt : _creationTime < garbageBefore,
      );
      if (garbage !== undefined) {
        const entries = await ctx.db
          .query("entries")
          .withIndex("by_version_path", (q) => q.eq("versionId", garbage.versionId))
          .take(DELETE_BATCH);
        for (const entry of entries) {
          await ctx.db.delete("entries", entry._id);
          if (await isUnreferenced(ctx, entry.storageId)) {
            await ctx.storage.delete(entry.storageId);
          }
        }
        if (entries.length < DELETE_BATCH) await ctx.db.delete("versions", garbage._id);
        await ctx.scheduler.runAfter(0, internal.lib.collect, {});
        return null;
      }
    }

    const files = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) =>
        storageCursor === undefined
          ? q.lt("_creationTime", garbageBefore)
          : q.gt("_creationTime", storageCursor).lt("_creationTime", garbageBefore),
      )
      .take(SWEEP_BATCH);
    for (const file of files) {
      if (await isUnreferenced(ctx, file._id)) await ctx.storage.delete(file._id);
    }
    if (files.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.lib.collect, {
        storageCursor: files[files.length - 1]._creationTime,
      });
    }
    return null;
  },
});

const routeHeaders = v.record(v.string(), v.string());

/**
 * Runs Cloudflare's asset handler for one request against one version. `state` is the kind of the
 * version's state, or `null` when the version does not exist. `asset` is `null` when the version
 * is still uploading or does not exist, or when no asset answers.
 */
export const route = query({
  args: { versionId: v.string(), method: v.string(), url: v.string(), headers: routeHeaders },
  returns: v.object({
    state: v.union(v.literal("uploading"), v.literal("ready"), v.literal("live"), v.null()),
    asset: v.union(
      v.null(),
      v.object({
        status: v.number(),
        headers: v.array(v.object({ name: v.string(), value: v.string() })),
        /** The storage URL of the body, when the response has one. */
        bodyUrl: v.union(v.string(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, { versionId, method, url, headers }) => {
    const version = await getVersion(ctx, versionId);
    if (version === null) return { state: null, asset: null };
    const state = version.state.kind;
    if (state === "uploading") return { state, asset: null };

    const configuration = normalizeConfiguration({
      ...AssetConfigSchema.parse(JSON.parse(version.config)),
      compatibility_date: COMPATIBILITY_DATE,
    });
    const request = new Request(url, { method, headers });
    const env = { JAEGER: mockJaegerBinding() };

    // `exists` returns an ETag; `getByETag` gets the entry back for that ETag.
    const found = new Map<string, Doc<"entries">>();
    const exists = async (pathname: string) => {
      const entry = await getEntry(ctx, versionId, pathname);
      if (entry === null) return null;
      const eTag = entry.sha256 + (await shortHash(entry.contentType ?? ""));
      found.set(eTag, entry);
      return eTag;
    };
    let bodyEntry: Doc<"entries"> | undefined;
    const getByETag = async (eTag: string) => {
      bodyEntry = found.get(eTag);
      if (bodyEntry === undefined) throw new Error(`No entry has the ETag ${eTag}.`);
      return {
        // `serveAsset` replaces this placeholder with the stored file.
        readableStream: new ReadableStream(),
        contentType: bodyEntry.contentType,
        cacheStatus: "MISS" as const,
      };
    };

    if (!(await canFetch(request, env, configuration, exists))) {
      return { state, asset: null };
    }
    const response = await handleRequest(
      request,
      env,
      configuration,
      exists,
      getByETag,
      new Analytics(),
    );
    // It describes Cloudflare's cache, which does not exist here.
    response.headers.delete("CF-Cache-Status");

    let bodyUrl: string | null = null;
    if (response.body !== null && bodyEntry !== undefined) {
      bodyUrl = await ctx.storage.getUrl(bodyEntry.storageId);
      // The file is gone from storage. As in `serveAsset` when storage answers 404, the answer must
      // not stay in a cache.
      if (bodyUrl === null) {
        return {
          state,
          asset: { status: 404, headers: [{ name: "cache-control", value: "no-store" }], bodyUrl },
        };
      }
    }
    return {
      state,
      asset: {
        status: response.status,
        headers: [...response.headers].map(([name, value]) => ({ name, value })),
        bodyUrl,
      },
    };
  },
});

/** Convex's `_storage` table holds the sha256 in base64; entries hold it in hex. */
function base64ToHex(base64: string) {
  return Array.from(atob(base64), (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join(
    "",
  );
}

/** The first 8 hex digits of the SHA-256 of `text`. */
async function shortHash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest, 0, 4), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
