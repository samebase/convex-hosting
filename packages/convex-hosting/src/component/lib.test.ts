/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { Manifest } from "./lib.js";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type Files = Record<string, { body: string; contentType?: string }>;

async function sha256Hex(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function manifestOf(files: Files, config: Manifest["config"]): Promise<Manifest> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, { body, contentType }]) => ({
      path,
      sha256: await sha256Hex(body),
      contentType,
    })),
  );
  return { config, entries };
}

/** Runs the calls of one upload: `startVersion`, the stored files, `finishVersion`. */
async function uploadVersion(
  t: ReturnType<typeof convexTest>,
  versionId: string,
  files: Files,
  config: Manifest["config"] = {},
) {
  const manifest = await manifestOf(files, config);
  const manifestId = await t.run((ctx) => ctx.storage.store(new Blob([JSON.stringify(manifest)])));
  await t.action(internal.lib.startVersion, { versionId, manifestId });
  for (const { path } of await t.query(internal.lib.missingEntries, { versionId })) {
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([files[path].body])));
    await t.mutation(internal.lib.recordFiles, { versionId, files: [{ path, storageId }] });
  }
  expect(await t.mutation(internal.lib.finishVersion, { versionId })).toBe(true);
}

async function tables(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    versions: (await ctx.db.query("versions").collect()).map((v) => [v.versionId, v.state]),
    entries: (await ctx.db.query("entries").collect()).map((e) => `${e.versionId}${e.path}`),
    files: (await ctx.db.system.query("_storage").collect()).length,
    lock: (await ctx.db.query("deploy").collect()).map((d) => d.versionId),
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

  test("startVersion creates an uploading version and reuses recorded files by sha256", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    await t.mutation(internal.lib.finishDeploy, { versionId: "v1", pushed: false });

    const manifest = await manifestOf(
      { ...site, "/new.txt": { body: "new", contentType: "text/plain" } },
      {},
    );
    const manifestId = await t.run((ctx) =>
      ctx.storage.store(new Blob([JSON.stringify(manifest)])),
    );
    await t.action(internal.lib.startVersion, { versionId: "v2", manifestId });
    // Idempotent for the same id and manifest.
    await t.action(internal.lib.startVersion, { versionId: "v2", manifestId });

    expect((await tables(t)).versions).toEqual([
      ["v1", "ready"],
      ["v2", "uploading"],
    ]);
    expect(await t.query(internal.lib.missingEntries, { versionId: "v2" })).toEqual([
      { path: "/new.txt", sha256: await sha256Hex("new") },
    ]);
  });

  test("recordFiles checks the stored file's sha256", async () => {
    const t = convexTest(schema, modules);
    const manifest = await manifestOf({ "/a.txt": { body: "a" } }, {});
    const manifestId = await t.run((ctx) =>
      ctx.storage.store(new Blob([JSON.stringify(manifest)])),
    );
    await t.action(internal.lib.startVersion, { versionId: "v1", manifestId });

    const wrong = await t.run((ctx) => ctx.storage.store(new Blob(["b"])));
    await expect(
      t.mutation(internal.lib.recordFiles, {
        versionId: "v1",
        files: [{ path: "/a.txt", storageId: wrong }],
      }),
    ).rejects.toThrow("does not match its sha256");
    expect(await t.mutation(internal.lib.finishVersion, { versionId: "v1" })).toBe(false);

    const right = await t.run((ctx) => ctx.storage.store(new Blob(["a"])));
    await t.mutation(internal.lib.recordFiles, {
      versionId: "v1",
      files: [{ path: "/a.txt", storageId: right }],
    });
    expect(await t.query(internal.lib.missingEntries, { versionId: "v1" })).toEqual([]);
    expect(await t.mutation(internal.lib.finishVersion, { versionId: "v1" })).toBe(true);
    expect((await tables(t)).versions).toEqual([["v1", "ready"]]);
  });
});

describe("lock", () => {
  test("a second startVersion is refused while a young lock exists", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.lib.createVersion, { versionId: "v1", config: "{}" });
    const manifest = await manifestOf({}, {});
    const manifestId = await t.run((ctx) =>
      ctx.storage.store(new Blob([JSON.stringify(manifest)])),
    );
    await expect(
      t.action(internal.lib.startVersion, { versionId: "v2", manifestId }),
    ).rejects.toThrow(
      /A deploy of version v1 is in progress: it refreshed the lock \d+ seconds ago/,
    );
  });

  test("a lock older than 2 minutes is taken over", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.mutation(internal.lib.createVersion, { versionId: "v1", config: "{}" });
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);
    await t.mutation(internal.lib.createVersion, { versionId: "v2", config: "{}" });
    expect((await tables(t)).lock).toEqual(["v2"]);
  });

  test("heartbeat refreshes the lock", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.mutation(internal.lib.createVersion, { versionId: "v1", config: "{}" });
    vi.advanceTimersByTime(90 * 1000);
    await t.mutation(internal.lib.heartbeat, { versionId: "v1" });

    // 90 seconds after the heartbeat, the lock is still young.
    vi.advanceTimersByTime(90 * 1000);
    await expect(
      t.mutation(internal.lib.createVersion, { versionId: "v2", config: "{}" }),
    ).rejects.toThrow("A deploy of version v1 is in progress");
  });

  test("a deploy that lost its lock fails; finishDeploy without pushed has nothing to release", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.lib.heartbeat, { versionId: "v1" })).rejects.toThrow(
      "The deploy of version v1 lost its lock.",
    );

    await t.mutation(internal.lib.createVersion, { versionId: "v1", config: "{}" });
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);
    await t.mutation(internal.lib.createVersion, { versionId: "v2", config: "{}" });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["a"])));
    const lost = "The deploy of version v1 lost its lock: a deploy of version v2 holds it.";
    await expect(
      t.mutation(internal.lib.recordFiles, {
        versionId: "v1",
        files: [{ path: "/a.txt", storageId }],
      }),
    ).rejects.toThrow(lost);
    await expect(t.mutation(internal.lib.finishVersion, { versionId: "v1" })).rejects.toThrow(lost);
    await expect(t.mutation(internal.lib.heartbeat, { versionId: "v1" })).rejects.toThrow(lost);
    await expect(
      t.mutation(internal.lib.finishDeploy, { versionId: "v1", pushed: true }),
    ).rejects.toThrow(lost);

    await t.mutation(internal.lib.finishDeploy, { versionId: "v1", pushed: false });
    expect((await tables(t)).lock).toEqual(["v2"]);
  });
});

describe("finishDeploy", () => {
  test("with pushed, deletes the other versions and unreferenced files, then releases", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    await t.mutation(internal.lib.finishDeploy, { versionId: "v1", pushed: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The manifest is gone; the three files stay.
    expect((await tables(t)).files).toBe(3);

    // v2 keeps index.html and replaces the script.
    await uploadVersion(t, "v2", {
      "/index.html": site["/index.html"],
      "/assets/app-b2.js": { body: "console.log(2)", contentType: "text/javascript" },
    });
    // A stored file that no entry references, such as an upload that was never recorded.
    await t.run((ctx) => ctx.storage.store(new Blob(["orphan"])));
    await t.mutation(internal.lib.finishDeploy, { versionId: "v2", pushed: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await tables(t)).toEqual({
      versions: [["v2", "ready"]],
      entries: ["v2/index.html", "v2/assets/app-b2.js"],
      files: 2,
      lock: [],
    });
  });

  test("without pushed, releases the lock and keeps the version", async () => {
    const t = convexTest(schema, modules);
    await uploadVersion(t, "v1", site);
    await t.mutation(internal.lib.finishDeploy, { versionId: "v1", pushed: false });
    const after = await tables(t);
    expect(after.versions).toEqual([["v1", "ready"]]);
    expect(after.lock).toEqual([]);
    expect(after.files).toBe(4);
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
    await t.mutation(internal.lib.createVersion, { versionId: "v1", config: "{}" });
    expect(await route(t, "v1", "/")).toEqual({ state: "uploading", asset: null });
    expect(await route(t, "v2", "/")).toEqual({ state: null, asset: null });
  });
});
