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
 * Versions that one `collect` call reads in its page. A version document holds its config, at
 * most 1 MiB (the CLI keeps the config at or below 900 KiB), so a page reads at most 8 MiB, and the
 * current live version, read through `by_live`, 1 MiB more. A page cannot hold every version:
 * failed deploys of the last day are not deleted yet, and each one is a version.
 */
const VERSION_PAGE = 8;

/**
 * Entries that one `collect` call deletes, without their stored files, across the versions of its
 * page. Entries below 4 KiB read and delete at most 4 MiB, which, with the 9 MiB of version
 * documents, keeps a call at 13 MiB of the 16 MiB read limit and, with the 8 version rows it may
 * delete and the one it may mark `deleting`, at 13 MiB written. Documents read: at most 1,009 of
 * 32,000. Index ranges: `by_live`, the page, and one range of entries per version, at most 10 of
 * 4,096. Writes: at most 1,000 entries, 8 versions, and the next call, 1,009 of 16,000.
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

/** The `at` of the newest live version, or `null` when no version is live. */
async function getNewestLiveAt(ctx: QueryCtx) {
  const newest = await ctx.db
    .query("versions")
    .withIndex("by_live", (q) => q.eq("state.kind", "live"))
    .order("desc")
    .first();
  return newest?.state.kind === "live" ? newest.state.at : null;
}

async function getVersionOrThrow(ctx: QueryCtx, versionId: string) {
  const version = await getVersion(ctx, versionId);
  if (version === null) throw new ConvexError(`Version ${versionId} does not exist.`);
  return version;
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
      if (stored === null) {
        throw new ConvexError(
          `The stored file of ${entry.path} is gone, deleted by the age rule; run the deploy again.`,
        );
      }
      if (base64ToHex(stored.sha256) !== entry.sha256) {
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
 * request that the version's pushed code serves, with the `at` of the newest live version that
 * `route` saw for that request. A mark succeeds only when the state it was based on is still the
 * state: when the newest live version changed between the request's lookup and this mark, it does
 * nothing, so a request whose code was replaced between its lookup and its mark cannot make its
 * version newest. A version that is already live stays as it is, so concurrent first requests are
 * fine.
 */
export const markLive = mutation({
  args: { versionId: v.string(), expectedNewestLiveAt: v.union(v.number(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { versionId, expectedNewestLiveAt }) => {
    const version = await getVersionOrThrow(ctx, versionId);
    if (version.state.kind === "live") return null;
    if (version.state.kind === "uploading") {
      throw new ConvexError(`Version ${versionId} is still uploading.`);
    }
    if (version.state.kind === "deleting") {
      throw new ConvexError(`Version ${versionId} is being deleted.`);
    }
    const newestLiveAt = await getNewestLiveAt(ctx);
    if (newestLiveAt !== expectedNewestLiveAt) return null;
    // Strictly newer than the newest, also within one millisecond, so that `collect` deletes it.
    const at = newestLiveAt === null ? Date.now() : Math.max(Date.now(), newestLiveAt + 1);
    await ctx.db.patch("versions", version._id, { state: { kind: "live", at } });
    await ctx.scheduler.runAfter(0, internal.lib.collect, { step: { kind: "files" } });
    return null;
  },
});

/**
 * One chain of calls, one batch per call, each scheduling the next with `runAfter(0)` while work
 * remains. First the `_storage` files that no entry references and that are older than
 * `GARBAGE_AGE_MS`; then the versions, a page of `VERSION_PAGE` at a time in creation order: the
 * live versions older than the current live one, whose code is gone because the current one has
 * served since, and the versions that are not live and older than `GARBAGE_AGE_MS`, with their
 * entries.
 *
 * A stored file is deleted when no entry references it, it is a day old, and it was already
 * unreferenced when the chain started: the files that this chain's version deletion frees wait for
 * a later chain, at a later switch. An upload in progress may have taken a stored file from
 * `knownFiles` and not recorded its entry yet; it therefore fails only if two switches happen
 * during that one upload, and a retry works.
 */
export const collect = internalMutation({
  args: {
    /**
     * The step of the chain: the file sweep, then the versions. `after` is the `_creationTime` of
     * the last file, or of the last version, that the previous call finished.
     */
    step: v.union(
      v.object({ kind: v.literal("files"), after: v.optional(v.number()) }),
      v.object({ kind: v.literal("versions"), after: v.optional(v.number()) }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { step }) => {
    const garbageBefore = Date.now() - GARBAGE_AGE_MS;
    const after = step.after;

    if (step.kind === "files") {
      const files = await ctx.db.system
        .query("_storage")
        .withIndex("by_creation_time", (q) =>
          after === undefined
            ? q.lt("_creationTime", garbageBefore)
            : q.gt("_creationTime", after).lt("_creationTime", garbageBefore),
        )
        .take(SWEEP_BATCH);
      for (const file of files) {
        const entry = await ctx.db
          .query("entries")
          .withIndex("by_storageId", (q) => q.eq("storageId", file._id))
          .first();
        if (entry === null) await ctx.storage.delete(file._id);
      }
      await ctx.scheduler.runAfter(0, internal.lib.collect, {
        step:
          files.length === SWEEP_BATCH
            ? { kind: "files", after: files[files.length - 1]._creationTime }
            : { kind: "versions" },
      });
      return null;
    }

    const currentAt = await getNewestLiveAt(ctx);
    const page = await ctx.db
      .query("versions")
      .withIndex("by_creation_time", (q) =>
        after === undefined ? q : q.gt("_creationTime", after),
      )
      .take(VERSION_PAGE);
    let budget = DELETE_BATCH;
    let finished = after;
    for (const version of page) {
      const { state } = version;
      const garbage =
        state.kind === "deleting" ||
        (state.kind === "live"
          ? currentAt !== null && state.at < currentAt
          : version._creationTime < garbageBefore);
      if (garbage) {
        const entries = await ctx.db
          .query("entries")
          .withIndex("by_version_path", (q) => q.eq("versionId", version.versionId))
          .take(budget);
        for (const entry of entries) await ctx.db.delete("entries", entry._id);
        if (entries.length === budget) {
          // The version may have more entries: the next call reads it again. Until its row goes,
          // it is `deleting`, so that no request serves it or marks it live between the pages.
          if (state.kind !== "deleting") {
            await ctx.db.patch("versions", version._id, { state: { kind: "deleting" } });
          }
          await ctx.scheduler.runAfter(0, internal.lib.collect, {
            step: { kind: "versions", after: finished },
          });
          return null;
        }
        budget -= entries.length;
        await ctx.db.delete("versions", version._id);
      }
      finished = version._creationTime;
    }
    if (page.length === VERSION_PAGE) {
      await ctx.scheduler.runAfter(0, internal.lib.collect, {
        step: { kind: "versions", after: finished },
      });
    }
    return null;
  },
});

const routeHeaders = v.record(v.string(), v.string());

/**
 * Runs Cloudflare's asset handler for one request against one version. `state` is the kind of the
 * version's state, or `null` when the version does not exist. `newestLiveAt` is, for a `ready`
 * version, the `at` of the newest live version that this query saw, which `serveAsset` passes to
 * `markLive`; otherwise `null`, and a live version's requests read nothing more. `asset` is
 * `null` when the version is uploading, being deleted, or does not exist, or when no asset answers.
 */
export const route = query({
  args: { versionId: v.string(), method: v.string(), url: v.string(), headers: routeHeaders },
  returns: v.object({
    state: v.union(
      v.literal("uploading"),
      v.literal("ready"),
      v.literal("live"),
      v.literal("deleting"),
      v.null(),
    ),
    newestLiveAt: v.union(v.number(), v.null()),
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
    if (version === null) return { state: null, newestLiveAt: null, asset: null };
    const state = version.state.kind;
    if (state === "uploading" || state === "deleting") {
      return { state, newestLiveAt: null, asset: null };
    }
    const newestLiveAt = state === "ready" ? await getNewestLiveAt(ctx) : null;

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
      return { state, newestLiveAt, asset: null };
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
          newestLiveAt,
          asset: { status: 404, headers: [{ name: "cache-control", value: "no-store" }], bodyUrl },
        };
      }
    }
    return {
      state,
      newestLiveAt,
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
