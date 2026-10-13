/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
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
) {
  return t.query(api.lib.route, {
    versionId,
    method: "GET",
    url: `https://example.convex.site${path}`,
    headers,
  });
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

describe("markLive", () => {
  test("marks a ready version live; a live version stays as it is", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    await t.mutation(api.lib.markLive, { versionId: "v1" });
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
    await t.mutation(api.lib.markLive, { versionId: "v1" });
    expect(await state()).toEqual(live);
    expect((await route(t, "v1", "/")).state).toBe("live");
  });

  test("refuses a version that is uploading or does not exist", async () => {
    const t = convexTest(schema, modules);
    await createVersion(t, "v1");
    await expect(t.mutation(api.lib.markLive, { versionId: "v1" })).rejects.toThrow(
      "Version v1 is still uploading.",
    );
    await expect(t.mutation(api.lib.markLive, { versionId: "v2" })).rejects.toThrow(
      "Version v2 does not exist.",
    );
  });
});

describe("collect", () => {
  test("a new live version deletes the version live before it and the files only it used", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    await t.mutation(api.lib.markLive, { versionId: "v1" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Three files and the config file.
    expect((await tables(t)).files).toBe(4);

    // v2 keeps index.html and replaces the script.
    vi.advanceTimersByTime(1000);
    await uploadVersion(t, "v2", {
      "/index.html": site["/index.html"],
      "/assets/app-b2.js": { body: "console.log(2)", contentType: "text/javascript" },
    });
    await t.mutation(api.lib.markLive, { versionId: "v2" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // index.html, the new script, and the two config files, which are younger than a day.
    expect(await tables(t)).toEqual({
      versions: [["v2", "live"]],
      entries: ["v2/index.html", "v2/assets/app-b2.js"],
      files: 4,
    });

    // A day later, the next pass deletes the files that no entry references.
    vi.advanceTimersByTime(DAY + 1);
    await t.mutation(internal.lib.collect, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await tables(t)).files).toBe(2);
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
    await t.mutation(api.lib.markLive, { versionId: "v3" });
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

  test("single-page-application answers navigations only", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site, { not_found_handling: "single-page-application" });
    const navigation = await route(t, "v1", "/settings/profile", { "sec-fetch-mode": "navigate" });
    const index = await route(t, "v1", "/");
    expect(navigation.asset?.status).toBe(200);
    expect(header(navigation.asset, "etag")).toBe(header(index.asset, "etag"));

    expect(await route(t, "v1", "/settings/profile")).toEqual({ state: "ready", asset: null });
  });

  test("the custom 404 page answers with its body", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site, { not_found_handling: "404-page" });
    const { asset } = await route(t, "v1", "/missing", { "sec-fetch-mode": "navigate" });
    expect(asset?.status).toBe(404);
    expect(asset?.bodyUrl).toEqual(expect.any(String));
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
