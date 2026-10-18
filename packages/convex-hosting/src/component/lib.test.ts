/// <reference types="vite-plus/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { Id } from "./_generated/dataModel.js";
import type { Config } from "./lib.js";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type Files = Record<string, { body: string; contentType?: string }>;

async function sha256Hex(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stores the config and calls `createVersion`. */
async function createVersion(
  t: ReturnType<typeof convexTest>,
  versionId: string,
  config: Config = {},
) {
  const configId = await t.run((ctx) => ctx.storage.store(new Blob([JSON.stringify(config)])));
  await t.action(internal.lib.createVersion, { versionId, configId });
}

/** Stores `body` and returns the complete entry for `path`. */
async function storedEntry(t: ReturnType<typeof convexTest>, path: string, body: string) {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([body])));
  return { path, sha256: await sha256Hex(body), storageId };
}

/**
 * Runs the calls of one upload: `createVersion`, `knownFiles`, the files it does not know,
 * `recordFiles`, `finishVersion`.
 */
async function uploadVersion(
  t: ReturnType<typeof convexTest>,
  versionId: string,
  files: Files,
  config: Config = {},
) {
  await createVersion(t, versionId, config);
  const sha256s = await Promise.all(Object.values(files).map(({ body }) => sha256Hex(body)));
  const known = await t.query(internal.lib.knownFiles, { sha256s });
  const storageIds = new Map(known.map(({ sha256, storageId }) => [sha256, storageId]));
  const entries = [];
  for (const [path, { body, contentType }] of Object.entries(files)) {
    const sha256 = await sha256Hex(body);
    const storageId =
      storageIds.get(sha256) ?? (await t.run((ctx) => ctx.storage.store(new Blob([body]))));
    storageIds.set(sha256, storageId);
    entries.push({ path, sha256, contentType, storageId });
  }
  await t.mutation(internal.lib.recordFiles, { versionId, entries });
  await t.mutation(internal.lib.finishVersion, { versionId });
}

async function tables(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    versions: (await ctx.db.query("versions").collect()).map((v) => [v.versionId, v.state.kind]),
    entries: (await ctx.db.query("entries").collect()).map((e) => `${e.versionId}${e.path}`),
    files: (await ctx.db.system.query("_storage").collect()).length,
  }));
}

const site: Files = {
  "/index.html": { body: "<h1>Home</h1>", contentType: "text/html; charset=utf-8" },
  "/404.html": { body: "<h1>Missing</h1>", contentType: "text/html; charset=utf-8" },
  "/assets/app-a1.js": { body: "console.log(1)", contentType: "text/javascript; charset=utf-8" },
};

function route(
  t: ReturnType<typeof convexTest>,
  versionId: string,
  path: string,
  headers: Record<string, string> = {},
  hasUserWorker = true,
  method = "GET",
) {
  return t.query(api.lib.route, {
    versionId,
    method,
    url: `https://example.convex.site${path}`,
    headers,
    hasUserWorker,
  });
}

async function markLive(t: ReturnType<typeof convexTest>, versionId: string) {
  await t.mutation(api.lib.markLive, { versionId });
}

/** The kind of each version's state, and the number of `collect` chains that `markLive` started. */
async function liveness(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    versions: Object.fromEntries(
      (await ctx.db.query("versions").collect()).map((v) => [v.versionId, v.state.kind]),
    ),
    collects: (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.args[0].step.kind === "files" && job.args[0].step.after === undefined,
    ).length,
  }));
}

function header(asset: { headers: { name: string; value: string }[] } | null, name: string) {
  return asset?.headers.find((h) => h.name === name)?.value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("upload", () => {
  test("generateUploadUrls returns count URLs", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.lib.generateUploadUrls, { count: 3 })).toHaveLength(3);
  });

  test("createVersion creates an uploading version, idempotent for the same id and config", async () => {
    const t = convexTest(schema, modules);
    await createVersion(t, "v1", { not_found_handling: "404-page" });
    await createVersion(t, "v1", { not_found_handling: "404-page" });
    expect((await tables(t)).versions).toEqual([["v1", "uploading"]]);
    await expect(createVersion(t, "v1", {})).rejects.toThrow(
      "Version v1 exists with a different config.",
    );
  });

  test("knownFiles returns the stored files that entries of any version have", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    const index = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("entries")
            .withIndex("by_version_path", (q) => q.eq("versionId", "v1").eq("path", "/index.html"))
            .unique()
        )?.storageId,
    );
    const sha256 = await sha256Hex("<h1>Home</h1>");
    expect(
      await t.query(internal.lib.knownFiles, { sha256s: [await sha256Hex("new"), sha256] }),
    ).toEqual([{ sha256, storageId: index }]);
  });

  test("recordFiles checks the stored file's sha256 and skips an entry it already has", async () => {
    const t = convexTest(schema, modules);
    await createVersion(t, "v1");
    const wrong = await storedEntry(t, "/a.txt", "b");
    await expect(
      t.mutation(internal.lib.recordFiles, {
        versionId: "v1",
        entries: [{ ...wrong, sha256: await sha256Hex("a") }],
      }),
    ).rejects.toThrow("The file stored for /a.txt does not match its sha256.");
    const gone = await storedEntry(t, "/gone.txt", "gone");
    await t.run((ctx) => ctx.storage.delete(gone.storageId));
    await expect(
      t.mutation(internal.lib.recordFiles, { versionId: "v1", entries: [gone] }),
    ).rejects.toThrow("The stored file of /gone.txt is gone");

    const right = await storedEntry(t, "/a.txt", "a");
    await t.mutation(internal.lib.recordFiles, { versionId: "v1", entries: [right] });
    // A retried batch passes.
    await t.mutation(internal.lib.recordFiles, { versionId: "v1", entries: [right] });
    expect((await tables(t)).entries).toEqual(["v1/a.txt"]);
    await expect(
      t.mutation(internal.lib.recordFiles, { versionId: "v1", entries: [wrong] }),
    ).rejects.toThrow("Version v1 has other contents at /a.txt.");

    await t.mutation(internal.lib.finishVersion, { versionId: "v1" });
    expect((await tables(t)).versions).toEqual([["v1", "ready"]]);
    await expect(
      t.mutation(internal.lib.recordFiles, { versionId: "v1", entries: [right] }),
    ).rejects.toThrow("Version v1 is ready, not uploading.");
  });
});

const DAY = 24 * 60 * 60 * 1000;

/** The steps of the `collect` calls that are scheduled and have not run. */
async function pendingSteps(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.state.kind === "pending")
      .map((job) => job.args[0].step),
  );
}

/** Runs the scheduled calls that are pending now, and only those. */
async function runNext(t: ReturnType<typeof convexTest>) {
  vi.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
}

describe("markLive", () => {
  test("marks a ready version live; a live version stays as it is", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    await markLive(t, "v1");
    const state = async () =>
      await t.run(
        async (ctx) =>
          (
            await ctx.db
              .query("versions")
              .withIndex("by_versionId", (q) => q.eq("versionId", "v1"))
              .unique()
          )?.state,
      );
    const live = await state();
    expect(live).toEqual({ kind: "live", at: Date.now() });
    vi.advanceTimersByTime(1000);
    await markLive(t, "v1");
    expect(await state()).toEqual(live);
    expect((await route(t, "v1", "/")).state).toBe("live");
  });

  test("refuses a version that is uploading or does not exist", async () => {
    const t = convexTest(schema, modules);
    await createVersion(t, "v1");
    await expect(markLive(t, "v1")).rejects.toThrow("Version v1 is still uploading.");
    await expect(markLive(t, "v2")).rejects.toThrow("Version v2 does not exist.");
  });

  test("an older upload never goes live over a newer one: a stale request's mark is refused", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await uploadVersion(t, "a", site);
    await uploadVersion(t, "b", site);
    // B's code replaces A's and its first request marks B live.
    await markLive(t, "b");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // A request that started on A's code reaches its mark after that.
    vi.advanceTimersByTime(1000);
    await markLive(t, "a");
    expect(await liveness(t)).toEqual({ versions: { a: "ready", b: "live" }, collects: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await route(t, "b", "/assets/app-a1.js")).asset?.status).toBe(200);
    expect((await tables(t)).entries).toContain("b/assets/app-a1.js");
  });

  test("a mark in the same millisecond as the newest is still strictly newer", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await uploadVersion(t, "a", site);
    await uploadVersion(t, "b", site);
    // The clock does not move between the two marks.
    await markLive(t, "a");
    await markLive(t, "b");
    const at = (versionId: string) =>
      t.run(async (ctx) => {
        const version = await ctx.db
          .query("versions")
          .withIndex("by_versionId", (q) => q.eq("versionId", versionId))
          .unique();
        return version?.state.kind === "live" ? version.state.at : null;
      });
    expect(await at("b")).toBe(Date.now() + 1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await liveness(t)).versions).toEqual({ b: "live" });
  });

  test("two first requests of one version mark it live once", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await uploadVersion(t, "a", site);
    await markLive(t, "a");
    vi.advanceTimersByTime(1000);
    await markLive(t, "a");
    expect(await liveness(t)).toEqual({ versions: { a: "live" }, collects: 1 });
  });
});

describe("collect", () => {
  test("a new live version deletes the version live before it and its entries, not its files", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    await markLive(t, "v1");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Three files and the config file.
    expect((await tables(t)).files).toBe(4);

    // v2 keeps index.html and replaces the script.
    vi.advanceTimersByTime(1000);
    await uploadVersion(t, "v2", {
      "/index.html": site["/index.html"],
      "/assets/app-b2.js": { body: "console.log(2)", contentType: "text/javascript" },
    });
    await markLive(t, "v2");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Every stored file survives: the shared index.html, and the files that no entry references
    // any more, which are younger than a day.
    expect(await tables(t)).toEqual({
      versions: [["v2", "live"]],
      entries: ["v2/index.html", "v2/assets/app-b2.js"],
      files: 6,
    });
  });

  test("deletes a stored file when no entry references it, it is a day old, and it was unreferenced when the chain started", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    // A deploy whose push failed: v1 never becomes live.
    await uploadVersion(t, "v1", site);
    const old = await t.run((ctx) => ctx.storage.store(new Blob(["old"])));
    vi.advanceTimersByTime(DAY + 1);
    const young = await t.run((ctx) => ctx.storage.store(new Blob(["young"])));
    const exists = (storageId: Id<"_storage">) =>
      t.run(async (ctx) => (await ctx.db.system.get("_storage", storageId)) !== null);

    await t.mutation(internal.lib.collect, { step: { kind: "files" } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await exists(old)).toBe(false);
    expect(await exists(young)).toBe(true);
    // The chain deleted v1 and its day-old config file, and kept the three files that v1 used.
    expect(await tables(t)).toEqual({ versions: [], entries: [], files: 4 });

    // A later chain deletes them.
    await t.mutation(internal.lib.collect, { step: { kind: "files" } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await tables(t)).files).toBe(1);
    expect(await exists(young)).toBe(true);
  });

  test("walks the versions a page of 8 at a time, with a creation-time cursor", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    // Twenty abandoned versions with large configs: one call must not read them all.
    const config: Config = {
      headers: { version: 2, rules: { "/*": { set: { "x-pad": "x".repeat(200_000) } } } },
    };
    for (let i = 0; i < 20; i++) await createVersion(t, `v${i}`, config);
    // The cursor after each version: its creation time, and it as the one version seen then.
    const cursors = await t.run(async (ctx) =>
      (await ctx.db.query("versions").collect()).map(({ _creationTime, _id }) => ({
        at: _creationTime,
        seen: [_id],
      })),
    );
    vi.advanceTimersByTime(DAY + 1);

    await t.mutation(internal.lib.collect, { step: { kind: "versions" } });
    expect((await tables(t)).versions).toHaveLength(12);
    expect(await pendingSteps(t)).toEqual([{ kind: "versions", after: cursors[7] }]);
    await runNext(t);
    expect((await tables(t)).versions).toHaveLength(4);
    expect(await pendingSteps(t)).toEqual([{ kind: "versions", after: cursors[15] }]);
    // The last page is not full, so the chain ends.
    await runNext(t);
    expect((await tables(t)).versions).toEqual([]);
    expect(await pendingSteps(t)).toEqual([]);
  });

  test("deletes the entries of a large version in batches of 1,000, and it is never marked live between them", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await createVersion(t, "large");
    const entry = await storedEntry(t, "/a.txt", "a");
    await t.mutation(internal.lib.recordFiles, {
      versionId: "large",
      entries: Array.from({ length: 1001 }, (_, i) => ({ ...entry, path: `/${i}.txt` })),
    });
    await t.mutation(internal.lib.finishVersion, { versionId: "large" });
    vi.advanceTimersByTime(DAY + 1);

    await t.mutation(internal.lib.collect, { step: { kind: "versions" } });
    const after = await tables(t);
    expect(after.versions).toEqual([["large", "deleting"]]);
    expect(after.entries).toHaveLength(1);
    // A request between the pages answers 404 and cannot mark the version live.
    expect(await route(t, "large", "/0.txt")).toEqual({ state: "deleting", asset: null });
    await expect(markLive(t, "large")).rejects.toThrow("Version large is being deleted.");
    // The next call reads the same version again and ends it.
    expect(await pendingSteps(t)).toEqual([{ kind: "versions" }]);
    await runNext(t);
    expect(await tables(t)).toMatchObject({ versions: [], entries: [] });
  });

  // convex-test gives every document its own creation time, so these tests resume at a cursor on
  // a shared time: the documents at that time that `seen` does not hold are handled, the others not.
  test("resumes the versions at the cursor's time, skipping only the versions it has seen", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    for (const id of ["a", "b", "c"]) await createVersion(t, id);
    const versions = await t.run((ctx) => ctx.db.query("versions").collect());
    vi.advanceTimersByTime(DAY + 1);
    // A cursor at b's time that has seen a, a version of that same time in a real deployment.
    const at = versions[1]._creationTime;
    await t.mutation(internal.lib.collect, {
      step: { kind: "versions", after: { at, seen: [versions[0]._id] } },
    });
    expect((await tables(t)).versions).toEqual([["a", "uploading"]]);

    // A cursor that has seen b at its time skips only b.
    const t2 = convexTest(schema, modules);
    for (const id of ["a", "b", "c"]) await createVersion(t2, id);
    const versions2 = await t2.run((ctx) => ctx.db.query("versions").collect());
    vi.advanceTimersByTime(DAY + 1);
    await t2.mutation(internal.lib.collect, {
      step: {
        kind: "versions",
        after: { at: versions2[1]._creationTime, seen: [versions2[1]._id] },
      },
    });
    expect((await tables(t2)).versions).toEqual([
      ["a", "uploading"],
      ["b", "uploading"],
    ]);
  });

  test("resumes the file sweep at the cursor's time, skipping only the files it has seen", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    for (const body of ["a", "b", "c"]) {
      await t.run((ctx) => ctx.storage.store(new Blob([body])));
    }
    const files = await t.run((ctx) => ctx.db.system.query("_storage").collect());
    vi.advanceTimersByTime(DAY + 1);
    // A cursor at b's time that has seen a, a file of that same time in a real deployment.
    await t.mutation(internal.lib.collect, {
      step: { kind: "files", after: { at: files[1]._creationTime, seen: [files[0]._id] } },
    });
    const left = await t.run(async (ctx) =>
      (await ctx.db.system.query("_storage").collect()).map((file) => file._id),
    );
    expect(left).toEqual([files[0]._id]);
  });

  test("deletes the versions that never became live once they are a day old", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    // An upload that died, and a deploy whose push failed.
    await createVersion(t, "died");
    await uploadVersion(t, "unpushed", { "/a.txt": { body: "a" } });
    vi.advanceTimersByTime(DAY + 1);
    // A deploy that is about to push.
    await uploadVersion(t, "young", { "/b.txt": { body: "b" } });
    await uploadVersion(t, "v3", site);
    await markLive(t, "v3");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await tables(t)).versions).toEqual([
      ["young", "ready"],
      ["v3", "live"],
    ]);
  });
});

describe("route", () => {
  test("a hit has Cloudflare's headers and an ETag; If-None-Match answers 304", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    const { state, asset } = await route(t, "v1", "/assets/app-a1.js");
    expect(state).toBe("ready");
    expect(asset?.status).toBe(200);
    expect(header(asset, "content-type")).toBe("text/javascript; charset=utf-8");
    expect(header(asset, "cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(header(asset, "cf-cache-status")).toBeUndefined();
    const eTag = header(asset, "etag");
    expect(eTag).toMatch(new RegExp(`^"${await sha256Hex("console.log(1)")}[0-9a-f]{8}"$`));
    expect(asset?.bodyUrl).toEqual(expect.any(String));

    const revalidated = await route(t, "v1", "/assets/app-a1.js", { "if-none-match": eTag ?? "" });
    expect(revalidated.asset?.status).toBe(304);
    expect(revalidated.asset?.bodyUrl).toBeNull();
  });

  test("the same bytes under two content types have two ETags", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", {
      "/a.txt": { body: "same", contentType: "text/plain" },
      "/a.js": { body: "same", contentType: "text/javascript" },
    });
    const txt = await route(t, "v1", "/a.txt");
    const js = await route(t, "v1", "/a.js");
    expect(header(txt.asset, "etag")).not.toBe(header(js.asset, "etag"));
    expect(header(js.asset, "content-type")).toBe("text/javascript");
  });

  test("with code, single-page-application answers navigations only", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site, { not_found_handling: "single-page-application" });
    const navigation = await route(t, "v1", "/settings/profile", { "sec-fetch-mode": "navigate" });
    const index = await route(t, "v1", "/");
    expect(navigation.asset?.status).toBe(200);
    expect(header(navigation.asset, "etag")).toBe(header(index.asset, "etag"));

    expect(await route(t, "v1", "/settings/profile")).toEqual({ state: "ready", asset: null });
  });

  test("without code, single-page-application answers every request, as a files-only Worker", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site, { not_found_handling: "single-page-application" });
    const index = await route(t, "v1", "/");
    // No `Sec-Fetch-Mode`, as from curl, a monitor, or a link-preview bot.
    const filesOnly = await route(t, "v1", "/about", {}, false);
    expect(filesOnly.asset?.status).toBe(200);
    expect(header(filesOnly.asset, "content-type")).toBe("text/html; charset=utf-8");
    expect(header(filesOnly.asset, "etag")).toBe(header(index.asset, "etag"));
    // With code, the same request is a miss, which the app answers.
    expect(await route(t, "v1", "/about", {}, true)).toEqual({ state: "ready", asset: null });
  });

  test("without code and with html_handling none, / answers index.html through the fallback", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site, {
      html_handling: "none",
      not_found_handling: "single-page-application",
    });
    const { asset } = await route(t, "v1", "/", {}, false);
    const index = await route(t, "v1", "/index.html", {}, false);
    expect(asset?.status).toBe(200);
    expect(header(asset, "etag")).toBe(header(index.asset, "etag"));
  });

  test("another method than GET or HEAD on a file answers 405; on a miss, the code or 404", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    for (const hasUserWorker of [true, false]) {
      const post = await route(t, "v1", "/index.html", {}, hasUserWorker, "POST");
      expect(post.asset?.status).toBe(405);
      expect(post.asset?.bodyUrl).toBeNull();
    }
    expect(await route(t, "v1", "/missing", {}, true, "POST")).toEqual({
      state: "ready",
      asset: null,
    });
    const miss = await route(t, "v1", "/missing", {}, false, "POST");
    expect(miss.asset?.status).toBe(404);
  });

  test("without code, a miss with not_found_handling none answers 404 with no-store", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    const miss = await route(t, "v1", "/missing", {}, false);
    expect(miss.asset).toEqual({
      status: 404,
      headers: [{ name: "cache-control", value: "no-store" }],
      bodyUrl: null,
    });
  });

  test("the custom 404 page answers with its body and no-store", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site, { not_found_handling: "404-page" });
    const { asset } = await route(t, "v1", "/missing", { "sec-fetch-mode": "navigate" });
    expect(asset?.status).toBe(404);
    expect(asset?.bodyUrl).toEqual(expect.any(String));
    expect(header(asset, "cache-control")).toBe("no-store");
    const filesOnly = await route(t, "v1", "/missing", {}, false);
    expect(filesOnly.asset?.status).toBe(404);
    expect(header(filesOnly.asset, "etag")).toBe(header(asset, "etag"));
  });

  test("a file that is gone from storage answers 404 with no-store", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    await t.run(async (ctx) => {
      const entry = await ctx.db
        .query("entries")
        .withIndex("by_version_path", (q) => q.eq("versionId", "v1").eq("path", "/index.html"))
        .unique();
      if (entry !== null) await ctx.storage.delete(entry.storageId);
    });
    expect(await route(t, "v1", "/")).toEqual({
      state: "ready",
      asset: {
        status: 404,
        headers: [{ name: "cache-control", value: "no-store" }],
        bodyUrl: null,
      },
    });
  });

  test("a _headers rule applies", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site, {
      headers: {
        version: 2,
        rules: { "/assets/*": { set: { "Cache-Control": "public, max-age=31536000, immutable" } } },
      },
    });
    const { asset } = await route(t, "v1", "/assets/app-a1.js");
    expect(header(asset, "cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("a _redirects rule applies", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site, {
      redirects: {
        version: 1,
        staticRules: { "/old": { status: 301, to: "/", lineNumber: 1 } },
        rules: {},
      },
    });
    const { asset } = await route(t, "v1", "/old?x=1");
    expect(asset?.status).toBe(301);
    expect(header(asset, "location")).toBe("/?x=1");
    expect(asset?.bodyUrl).toBeNull();
  });

  test("a version that is uploading or does not exist reports its state", async () => {
    const t = convexTest(schema, modules);
    await createVersion(t, "v1");
    expect(await route(t, "v1", "/")).toEqual({ state: "uploading", asset: null });
    expect(await route(t, "v2", "/")).toEqual({ state: null, asset: null });
  });
});
