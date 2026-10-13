import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { z } from "zod";
import { Analytics } from "../workers-shared/asset-worker/src/analytics.js";
import { normalizeConfiguration } from "../workers-shared/asset-worker/src/configuration.js";
import { canFetch, handleRequest } from "../workers-shared/asset-worker/src/handler.js";
import {
  MAX_DYNAMIC_REDIRECT_RULES,
  MAX_HEADER_RULES,
  MAX_STATIC_REDIRECT_RULES,
} from "../workers-shared/utils/configuration/constants.js";
import { mockJaegerBinding } from "../workers-shared/utils/tracing.js";
import { AssetConfigSchema, type AssetConfig } from "../workers-shared/utils/types.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { etagMatches } from "./serving.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a superseded version stays, for a rollback and for the immutable fallback. */
const RETENTION_MS = 7 * DAY_MS;
const MAX_ENTRIES = 4000;
const MAX_CONFIG_BYTES = 256 * 1024;
/** Entries per `writeEntries` mutation. */
const ENTRY_WRITE_BATCH = 500;
/** Rows that one `cleanup` call deletes, and versions and `_storage` objects that it checks. */
const CLEANUP_ROWS = 200;
/** Entries at one immutable path that a lookup reads for a ready version. */
const IMMUTABLE_PATH_ROWS = 8;
/** The first date with navigation detection (`Sec-Fetch-Mode`) in the asset worker. */
const NAVIGATION_COMPATIBILITY_DATE = "2025-04-01";

const manifestSchema = z.object({
  versionId: z.string().regex(/^v_[a-z2-7]{26}$/),
  config: AssetConfigSchema,
  entries: z
    .array(
      z.object({
        path: z
          .string()
          .startsWith("/")
          .refine((path) => new TextEncoder().encode(path).byteLength <= 1024, {
            message: "A path can have at most 1,024 bytes.",
          }),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z
          .number()
          .int()
          .nonnegative()
          .max(25 * 1024 * 1024),
        contentType: z.string(),
        immutable: z.boolean(),
      }),
    )
    .max(MAX_ENTRIES),
});

const pendingEntryValidator = v.object({ path: v.string(), sha256: v.string() });
const uploadResultValidator = v.object({
  state: v.union(v.literal("uploading"), v.literal("ready")),
  pending: v.array(pendingEntryValidator),
});
const headerListValidator = v.array(v.object({ name: v.string(), value: v.string() }));

export const generateUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/**
 * Reads and checks the manifest that the CLI uploaded, creates the version, and writes its entries.
 * A repeat with the same manifest continues an interrupted start.
 */
export const startVersion = internalAction({
  args: { versionId: v.string(), manifestStorageId: v.id("_storage") },
  returns: uploadResultValidator,
  handler: async (
    ctx,
    { versionId, manifestStorageId },
  ): Promise<Infer<typeof uploadResultValidator>> => {
    const manifestBlob = await ctx.storage.get(manifestStorageId);
    if (manifestBlob === null) {
      throw new Error(`The manifest ${manifestStorageId} is not in storage.`);
    }
    const manifestBytes = await manifestBlob.arrayBuffer();
    const manifest = manifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    if (manifest.versionId !== versionId) {
      throw new Error(`The manifest is for ${manifest.versionId}, not ${versionId}.`);
    }
    if (new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length) {
      throw new Error("The manifest has duplicate paths.");
    }
    const config = JSON.stringify(manifest.config);
    checkConfig(manifest.config);
    if (new TextEncoder().encode(config).byteLength > MAX_CONFIG_BYTES) {
      throw new Error(`The config is above ${MAX_CONFIG_BYTES} bytes.`);
    }

    const state = await ctx.runMutation(internal.lib.createVersion, {
      versionId,
      config,
      manifestSha256: hex(await crypto.subtle.digest("SHA-256", manifestBytes)),
      entryCount: manifest.entries.length,
    });
    const pending: Array<Infer<typeof pendingEntryValidator>> = [];
    if (state === "uploading") {
      for (let start = 0; start < manifest.entries.length; start += ENTRY_WRITE_BATCH) {
        const batch = manifest.entries.slice(start, start + ENTRY_WRITE_BATCH);
        const batchPending: Array<Infer<typeof pendingEntryValidator>> = await ctx.runMutation(
          internal.lib.writeEntries,
          {
            versionId,
            entries: batch.map((entry) => ({
              path: entry.path,
              sha256: entry.sha256,
              size: entry.size,
              contentType: entry.contentType,
              immutable: entry.immutable,
            })),
          },
        );
        pending.push(...batchPending);
      }
    }
    await ctx.storage.delete(manifestStorageId);
    return { state, pending };
  },
});

/** Creates the version, or checks that an existing one has the same manifest. */
export const createVersion = internalMutation({
  args: {
    versionId: v.string(),
    config: v.string(),
    manifestSha256: v.string(),
    entryCount: v.number(),
  },
  returns: v.union(v.literal("uploading"), v.literal("ready")),
  handler: async (ctx, { versionId, config, manifestSha256, entryCount }) => {
    const existing = await getVersion(ctx, versionId);
    if (existing === null) {
      await ctx.db.insert("versions", {
        versionId,
        state: "uploading",
        config,
        manifestSha256,
        entryCount,
        createdAt: Date.now(),
      });
      return "uploading";
    }
    if (existing.manifestSha256 !== manifestSha256) {
      throw new Error(`Version ${versionId} exists with a different manifest.`);
    }
    if (existing.state === "deleting") throw new Error(`Version ${versionId} is deleting.`);
    return existing.state;
  },
});

/**
 * Inserts the entries that the version does not have yet and returns the ones without a file. An
 * immutable entry fails when a ready version has different bytes at the same path.
 */
export const writeEntries = internalMutation({
  args: {
    versionId: v.string(),
    entries: v.array(
      v.object({
        path: v.string(),
        sha256: v.string(),
        size: v.number(),
        contentType: v.string(),
        immutable: v.boolean(),
      }),
    ),
  },
  returns: v.array(pendingEntryValidator),
  handler: async (ctx, { versionId, entries }) => {
    if (entries.length > ENTRY_WRITE_BATCH) {
      throw new Error(`writeEntries takes at most ${ENTRY_WRITE_BATCH} entries.`);
    }
    await requireState(ctx, versionId, "uploading");
    const isReady = readyCheck(ctx);
    const pending: Array<Infer<typeof pendingEntryValidator>> = [];
    for (const entry of entries) {
      const existing = await getEntry(ctx, versionId, entry.path);
      if (existing !== null) {
        if (existing.storageId === undefined) {
          pending.push({ path: existing.path, sha256: existing.sha256 });
        }
        continue;
      }
      if (entry.immutable) {
        const other = await newestReadyImmutableEntry(ctx, isReady, entry.path, versionId);
        if (other !== null && other.sha256 !== entry.sha256) {
          throw new Error(
            `${entry.path} is immutable, but version ${other.versionId} has different bytes at that path.`,
          );
        }
      }
      await ctx.db.insert("entries", {
        versionId,
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
        contentType: entry.contentType,
        immutable: entry.immutable,
      });
      pending.push({ path: entry.path, sha256: entry.sha256 });
    }
    return pending;
  },
});

/**
 * Sets the uploaded file of an entry after checking the digest and size that Convex recorded for
 * the object. A failed check deletes the object and returns `ok: false`, because a throw would roll
 * the deletion back.
 */
export const recordFile = internalMutation({
  args: { versionId: v.string(), path: v.string(), storageId: v.id("_storage") },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, { versionId, path, storageId }) => {
    await requireState(ctx, versionId, "uploading");
    const entry = await getEntry(ctx, versionId, path);
    if (entry?.storageId === storageId) return { ok: true as const };
    const object = await ctx.db.system.get("_storage", storageId);
    if (object === null) {
      return { ok: false as const, reason: `The object ${storageId} is not in storage.` };
    }
    if (entry === null) {
      await deleteUnreferencedObject(ctx, storageId);
      return { ok: false as const, reason: `Version ${versionId} has no entry ${path}.` };
    }
    if (entry.storageId !== undefined) {
      await deleteUnreferencedObject(ctx, storageId);
      return { ok: true as const };
    }
    // `_storage` keeps the digest as base64; the manifest uses hex.
    const objectSha256 = hex(Uint8Array.from(atob(object.sha256), (char) => char.charCodeAt(0)));
    if (objectSha256 !== entry.sha256 || object.size !== entry.size) {
      await deleteUnreferencedObject(ctx, storageId);
      return {
        ok: false as const,
        reason: `The object for ${path} has sha256 ${objectSha256} and ${object.size} bytes; the manifest has ${entry.sha256} and ${entry.size} bytes.`,
      };
    }
    await ctx.db.patch("entries", entry._id, { storageId });
    return { ok: true as const };
  },
});

const checkEntriesResultValidator = v.object({
  state: v.union(v.literal("uploading"), v.literal("ready")),
  entryCount: v.number(),
  counted: v.number(),
  pending: v.array(pendingEntryValidator),
  // Immutable paths with other bytes in the newest ready version that has them.
  conflicts: v.array(v.string()),
  continueCursor: v.string(),
  isDone: v.boolean(),
});

/**
 * Marks the version ready when every entry has a file and no immutable path conflicts with a ready
 * version, else returns the entries without a file. It checks the entries in batches. Releases for
 * one target run one at a time (the CI rule in docs/design.md, Deploy), so no other version of the
 * target becomes ready between the batches, and they need not be one transaction.
 */
export const finishVersion = internalAction({
  args: { versionId: v.string() },
  returns: uploadResultValidator,
  handler: async (ctx, { versionId }): Promise<Infer<typeof uploadResultValidator>> => {
    let cursor: string | null = null;
    let counted = 0;
    let entryCount = 0;
    const pending: Array<Infer<typeof pendingEntryValidator>> = [];
    const conflicts: string[] = [];
    while (true) {
      const page: Infer<typeof checkEntriesResultValidator> = await ctx.runQuery(
        internal.lib.checkEntries,
        { versionId, paginationOpts: { numItems: ENTRY_WRITE_BATCH, cursor } },
      );
      if (page.state === "ready") return { state: "ready", pending: [] };
      entryCount = page.entryCount;
      counted += page.counted;
      pending.push(...page.pending);
      conflicts.push(...page.conflicts);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    if (conflicts.length > 0) {
      throw new Error(
        `A ready version has different bytes at these immutable paths: ${conflicts.join(", ")}`,
      );
    }
    if (counted !== entryCount) {
      throw new Error(
        `Version ${versionId} has ${counted} of ${entryCount} entries. Run startVersion again.`,
      );
    }
    if (pending.length > 0) return { state: "uploading", pending };
    await ctx.runMutation(internal.lib.markReady, { versionId, entryCount: counted });
    return { state: "ready", pending: [] };
  },
});

export const checkEntries = internalQuery({
  args: { versionId: v.string(), paginationOpts: paginationOptsValidator },
  returns: checkEntriesResultValidator,
  handler: async (ctx, { versionId, paginationOpts }) => {
    const version = await getVersion(ctx, versionId);
    if (version === null) throw new Error(`Version ${versionId} does not exist.`);
    if (version.state === "deleting") throw new Error(`Version ${versionId} is deleting.`);
    if (version.state === "ready") {
      return {
        state: version.state,
        entryCount: version.entryCount,
        counted: 0,
        pending: [],
        conflicts: [],
        continueCursor: "",
        isDone: true,
      };
    }
    const { page, continueCursor, isDone } = await ctx.db
      .query("entries")
      .withIndex("by_version_path", (q) => q.eq("versionId", versionId))
      .paginate(paginationOpts);
    const isReady = readyCheck(ctx);
    const conflicts: string[] = [];
    for (const entry of page) {
      if (!entry.immutable) continue;
      const other = await newestReadyImmutableEntry(ctx, isReady, entry.path, versionId);
      if (other !== null && other.sha256 !== entry.sha256) conflicts.push(entry.path);
    }
    return {
      state: version.state,
      entryCount: version.entryCount,
      counted: page.length,
      pending: page.flatMap((entry) =>
        entry.storageId === undefined ? [{ path: entry.path, sha256: entry.sha256 }] : [],
      ),
      conflicts,
      continueCursor,
      isDone,
    };
  },
});

export const markReady = internalMutation({
  args: { versionId: v.string(), entryCount: v.number() },
  returns: v.null(),
  handler: async (ctx, { versionId, entryCount }) => {
    const version = await getVersion(ctx, versionId);
    if (version === null) throw new Error(`Version ${versionId} does not exist.`);
    if (version.state === "deleting") throw new Error(`Version ${versionId} is deleting.`);
    if (version.entryCount !== entryCount) {
      throw new Error(`Version ${versionId} has ${version.entryCount} entries, not ${entryCount}.`);
    }
    if (version.state === "uploading") {
      await ctx.db.patch("versions", version._id, { state: "ready" });
    }
    return null;
  },
});

/** Points the site at a ready version. Returns the version that was live before this call. */
export const activate = internalMutation({
  args: { versionId: v.string(), afterCodePush: v.boolean() },
  returns: v.object({ previousVersionId: v.union(v.string(), v.null()) }),
  handler: async (ctx, { versionId, afterCodePush }) => {
    const version = await requireState(ctx, versionId, "ready");
    const site = await ctx.db.query("site").first();
    const previousVersionId = site?.liveVersionId ?? null;
    if (previousVersionId === versionId) return { previousVersionId };

    const now = Date.now();
    if (previousVersionId !== null) {
      const previous = await getVersion(ctx, previousVersionId);
      if (previous !== null) {
        await ctx.db.patch("versions", previous._id, { supersededAt: now });
      }
    }
    await ctx.db.patch("versions", version._id, {
      liveAt: now,
      supersededAt: undefined,
      activatedAfterCodePush: afterCodePush,
    });
    if (site === null) {
      await ctx.db.insert("site", { liveVersionId: versionId });
    } else {
      await ctx.db.patch("site", site._id, { liveVersionId: versionId });
    }
    return { previousVersionId };
  },
});

export const getLiveVersion = query({
  args: {},
  returns: v.union(v.object({ versionId: v.string(), liveAt: v.number() }), v.null()),
  handler: async (ctx) => {
    const version = await getLive(ctx);
    if (version === null) return null;
    if (version.liveAt === undefined) {
      throw new Error(`The live version ${version.versionId} has no activation time.`);
    }
    return { versionId: version.versionId, liveAt: version.liveAt };
  },
});

/**
 * Routes one request against the live version with Cloudflare's asset handler, in one transaction.
 * The caller builds the response and reads `body` from storage.
 */
export const route = query({
  args: {
    method: v.union(v.literal("GET"), v.literal("HEAD")),
    url: v.string(),
    headers: headerListValidator,
    exact: v.boolean(),
  },
  returns: v.union(
    v.object({ handled: v.literal(false) }),
    v.object({
      handled: v.literal(true),
      status: v.number(),
      headers: headerListValidator,
      body: v.union(
        v.object({
          storageId: v.id("_storage"),
          storageUrl: v.string(),
          contentType: v.string(),
        }),
        v.null(),
      ),
    }),
  ),
  handler: async (ctx, { method, url, headers, exact }) => {
    const version = await getLive(ctx);
    if (version === null) {
      return {
        handled: true as const,
        status: 404,
        headers: [{ name: "Cache-Control", value: "no-store" }],
        body: null,
      };
    }
    const request = new Request(url, {
      method,
      headers: headers.map(({ name, value }): [string, string] => [name, value]),
    });
    const versionConfig: AssetConfig = JSON.parse(version.config);
    versionConfig.compatibility_date ??= NAVIGATION_COMPATIBILITY_DATE;
    if (exact) {
      versionConfig.html_handling = "none";
      versionConfig.not_found_handling = "none";
    }
    // `canFetch` does this by itself; `handleRequest` does not, so a rewrite could still serve the
    // single-page-application fallback to a script.
    if (request.headers.get("Sec-Fetch-Mode") !== "navigate") {
      versionConfig.not_found_handling = "none";
    }
    const config = normalizeConfiguration(versionConfig);
    const env = { JAEGER: mockJaegerBinding() };

    // Lookups for this request by path, and the entries that `exists` selected by key.
    const lookups = new Map<string, Doc<"entries"> | null>();
    const selected = new Map<string, Doc<"entries">>();
    const isReady = readyCheck(ctx);
    const exists = async (path: string) => {
      let entry = lookups.get(path);
      if (entry === undefined) {
        entry = await lookupEntry(ctx, isReady, version.versionId, path);
        lookups.set(path, entry);
      }
      if (entry === null) return null;
      // The handler sends the key as the ETag. The same bytes with another content type are a
      // different response, so they get a different key.
      const contentTypeHash = hex(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.contentType)),
      );
      const key = `${entry.sha256}-${contentTypeHash.slice(0, 8)}`;
      selected.set(key, entry);
      return key;
    };

    if (!(await canFetch(request, env, config, exists))) return { handled: false as const };

    const served: { entry?: Doc<"entries"> } = {};
    const getByETag = async (key: string) => {
      const entry = selected.get(key);
      if (entry === undefined) throw new Error(`No entry was selected for ${key}.`);
      served.entry = entry;
      // Never read: the caller fetches the body from storage.
      return {
        readableStream: new ReadableStream(),
        contentType: entry.contentType,
        cacheStatus: "MISS" as const,
      };
    };
    const response = await handleRequest(request, env, config, exists, getByETag, new Analytics());

    if (response.status >= 400) {
      // Convex's Cloudflare front caches a 404 for a path with a static extension, and a
      // `_headers` rule must not make an error cacheable.
      for (const name of [
        "Cache-Control",
        "CDN-Cache-Control",
        "Cloudflare-CDN-Cache-Control",
        "Surrogate-Control",
      ]) {
        response.headers.delete(name);
      }
      response.headers.set("Cache-Control", "no-store");
    } else if ((response.status === 200 || response.status === 304) && served.entry?.immutable) {
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }

    const etag = response.headers.get("ETag");
    if (
      response.status === 200 &&
      etag !== null &&
      etagMatches(request.headers.get("If-None-Match"), etag)
    ) {
      // The handler compares the whole header with one ETag, so `*` and a list got a 200.
      const cacheControl = response.headers.get("Cache-Control");
      return {
        handled: true as const,
        status: 304,
        headers: [
          ...(cacheControl === null ? [] : [{ name: "cache-control", value: cacheControl }]),
          { name: "etag", value: etag },
        ],
        body: null,
      };
    }

    let body = null;
    // A 200, or the 404 page of `not_found_handling: "404-page"`. HEAD and 304 have no body.
    if (response.body !== null && served.entry?.storageId !== undefined) {
      const storageUrl = await ctx.storage.getUrl(served.entry.storageId);
      if (storageUrl === null) throw new Error(`The object for ${served.entry.path} is missing.`);
      body = {
        storageId: served.entry.storageId,
        storageUrl,
        contentType: served.entry.contentType,
      };
    }
    return {
      handled: true as const,
      status: response.status,
      headers: Array.from(response.headers, ([name, value]) => ({ name, value })),
      body,
    };
  },
});

/**
 * Bounded cleanup, started hourly by crons.ts. It checks the next page of versions and marks the
 * expired ones `deleting`, deletes their entries and objects, then scans a page of `_storage` for
 * unreferenced objects older than a day. It schedules itself again at once while deletions or
 * unchecked versions remain.
 */
export const cleanup = internalMutation({
  args: {},
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx): Promise<{ done: boolean }> => {
    const now = Date.now();
    const site = await ctx.db.query("site").first();
    // The newest activation after a code push that is more than seven days old: its renderer
    // replaced the renderers of the versions before it.
    const codePush = await ctx.db
      .query("versions")
      .withIndex("by_codePush_liveAt", (q) =>
        q.eq("activatedAfterCodePush", true).lt("liveAt", now - RETENTION_MS),
      )
      .order("desc")
      .first();
    const versions = await ctx.db
      .query("versions")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", site?.versionScanCursor ?? 0))
      .take(CLEANUP_ROWS);
    for (const version of versions) {
      if (version.versionId !== site?.liveVersionId && isExpired(version, codePush, now)) {
        await ctx.db.patch("versions", version._id, { state: "deleting" });
      }
    }
    // A full page means that more versions follow; a short page ends the scan, and the next one
    // starts again at the oldest version.
    const versionScanCursor =
      versions.length === CLEANUP_ROWS ? versions[versions.length - 1]._creationTime : undefined;

    let budget = CLEANUP_ROWS;
    const deleting = await ctx.db
      .query("versions")
      .withIndex("by_state", (q) => q.eq("state", "deleting"))
      .take(CLEANUP_ROWS);
    for (const version of deleting) {
      const entries = await ctx.db
        .query("entries")
        .withIndex("by_version_path", (q) => q.eq("versionId", version.versionId))
        .take(budget);
      for (const entry of entries) {
        await ctx.db.delete("entries", entry._id);
        if (entry.storageId !== undefined) await deleteUnreferencedObject(ctx, entry.storageId);
      }
      budget -= entries.length;
      if (budget === 0) break;
      await ctx.db.delete("versions", version._id);
      budget -= 1;
      if (budget === 0) break;
    }

    let storageScanCursor = site?.storageScanCursor;
    if (budget > 0) {
      // Objects of uploads whose `recordFile` never ran, and manifests of failed starts.
      const scan = await ctx.db.system
        .query("_storage")
        .paginate({ cursor: storageScanCursor ?? null, numItems: budget });
      for (const object of scan.page) {
        if (object._creationTime < now - DAY_MS) await deleteUnreferencedObject(ctx, object._id);
      }
      storageScanCursor = scan.isDone ? undefined : scan.continueCursor;
    }
    if (site !== null) {
      await ctx.db.patch("site", site._id, { versionScanCursor, storageScanCursor });
    } else if (versionScanCursor !== undefined || storageScanCursor !== undefined) {
      await ctx.db.insert("site", { versionScanCursor, storageScanCursor });
    }

    const done = budget > 0 && versionScanCursor === undefined;
    if (!done) await ctx.scheduler.runAfter(0, internal.lib.cleanup, {});
    return { done };
  },
});

/**
 * An `uploading` version older than a day; a version activated without a code push, seven days
 * after a later activation superseded it; and a version activated after a code push or never
 * activated, seven days after a later activation that came after a code push. The backend runs the
 * renderer of the last code push, so a file-only activation does not replace it, and the files of
 * that renderer's version must stay. A never-activated version can be a release whose push
 * succeeded and whose activation failed.
 */
function isExpired(version: Doc<"versions">, codePush: Doc<"versions"> | null, now: number) {
  switch (version.state) {
    case "deleting":
      return false;
    case "uploading":
      return version.createdAt < now - DAY_MS;
    case "ready":
      if (version.activatedAfterCodePush === false) {
        return version.supersededAt !== undefined && version.supersededAt < now - RETENTION_MS;
      }
      return (
        codePush?.liveAt !== undefined && codePush.liveAt > (version.liveAt ?? version.createdAt)
      );
    default:
      return version.state satisfies never;
  }
}

/** Rule counts and the base path, so a bad config fails the upload and not every request. */
function checkConfig(config: AssetConfig) {
  const ruleCounts = [
    ["header", Object.keys(config.headers?.rules ?? {}).length, MAX_HEADER_RULES],
    [
      "static redirect",
      Object.keys(config.redirects?.staticRules ?? {}).length,
      MAX_STATIC_REDIRECT_RULES,
    ],
    [
      "dynamic redirect",
      Object.keys(config.redirects?.rules ?? {}).length,
      MAX_DYNAMIC_REDIRECT_RULES,
    ],
  ] as const;
  for (const [kind, count, max] of ruleCounts) {
    if (count > max) throw new Error(`The config has ${count} ${kind} rules; the limit is ${max}.`);
  }
  if (
    config.compatibility_date !== undefined &&
    config.compatibility_date < NAVIGATION_COMPATIBILITY_DATE
  ) {
    throw new Error(`The config's compatibility_date is before ${NAVIGATION_COMPATIBILITY_DATE}.`);
  }
  // Throws for an invalid base_path. It can add compatibility flags to its argument, so the caller
  // serializes the config first.
  normalizeConfiguration(config);
}

/**
 * The version's entry at `path`; else, for an immutable path, the newest entry at `path` from
 * another ready version; else null.
 */
async function lookupEntry(
  ctx: QueryCtx,
  isReady: (versionId: string) => Promise<boolean>,
  versionId: string,
  path: string,
) {
  const own = await getEntry(ctx, versionId, path);
  if (own?.storageId !== undefined) return own;
  return await newestReadyImmutableEntry(ctx, isReady, path, versionId);
}

/**
 * The newest immutable entry at `path` from a ready version other than `versionId`. It reads at
 * most `IMMUTABLE_PATH_ROWS` entries at the path, newest first, and treats more as none found:
 * entries of uploading or deleting versions come before a ready one only for a short time.
 */
async function newestReadyImmutableEntry(
  ctx: QueryCtx,
  isReady: (versionId: string) => Promise<boolean>,
  path: string,
  versionId: string,
) {
  const candidates = await ctx.db
    .query("entries")
    .withIndex("by_immutable_path", (q) => q.eq("immutable", true).eq("path", path))
    .order("desc")
    .take(IMMUTABLE_PATH_ROWS);
  for (const candidate of candidates) {
    if (candidate.versionId !== versionId && (await isReady(candidate.versionId))) {
      return candidate;
    }
  }
  return null;
}

async function getLive(ctx: QueryCtx) {
  const site = await ctx.db.query("site").first();
  if (site?.liveVersionId === undefined) return null;
  return await getVersion(ctx, site.liveVersionId);
}

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

async function requireState(ctx: QueryCtx, versionId: string, state: Doc<"versions">["state"]) {
  const version = await getVersion(ctx, versionId);
  if (version === null) throw new Error(`Version ${versionId} does not exist.`);
  if (version.state !== state) {
    throw new Error(`Version ${versionId} is ${version.state}, not ${state}.`);
  }
  return version;
}

/** Version states read once per function call. */
function readyCheck(ctx: QueryCtx) {
  const ready = new Map<string, boolean>();
  return async (versionId: string) => {
    let isReady = ready.get(versionId);
    if (isReady === undefined) {
      isReady = (await getVersion(ctx, versionId))?.state === "ready";
      ready.set(versionId, isReady);
    }
    return isReady;
  };
}

/** Versions own their files, but a CLI may record one object for two paths of a version. */
async function deleteUnreferencedObject(ctx: MutationCtx, storageId: Id<"_storage">) {
  const reference = await ctx.db
    .query("entries")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  if (reference === null) await ctx.storage.delete(storageId);
}

function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
