/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { api, components, internal } from "./_generated/api.js";
import { fileStorage, initConvexTest } from "./setup.test.js";

async function stage(t: ReturnType<typeof initConvexTest>, deploymentId: string, paths: string[]) {
  const assets = [];
  for (const path of paths) {
    assets.push({
      path,
      fileStorageId: await t.action(fileStorage.store, { body: deploymentId + path }),
      contentType: path.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "application/javascript; charset=utf-8",
      deploymentId,
    });
  }
  for (let offset = 0; offset < assets.length; offset += 100) {
    await t.mutation(internal.lib.stageAssets, { assets: assets.slice(offset, offset + 100) });
  }
  return assets;
}

async function publish(
  t: ReturnType<typeof initConvexTest>,
  deploymentId: string,
  paths: string[],
) {
  const assets = await stage(t, deploymentId, paths);
  await t.mutation(internal.lib.publishDeployment, {
    currentDeploymentId: deploymentId,
    expectedAssetCount: assets.length,
  });
  return assets;
}

describe("component lib", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("generates upload URLs in bounded batches", async () => {
    const t = initConvexTest();
    expect(await t.mutation(internal.lib.generateUploadUrl, {})).toContain("http");
    const urls = await t.mutation(internal.lib.generateUploadUrls, { count: 3 });
    expect(urls).toHaveLength(3);
    for (const url of urls) expect(url).toContain("http");
    await expect(t.mutation(internal.lib.generateUploadUrls, { count: 101 })).rejects.toThrow(
      "integer from 1 to 100",
    );
  });

  test("publishes the complete manifest and deployment info together", async () => {
    const t = initConvexTest();
    await publish(t, "deploy-old", ["/index.html", "/old.js"]);
    const oldIndex = await t.query(internal.lib.getByPath, { path: "/index.html" });
    const assets = await stage(t, "deploy-new", ["/index.html", "/app.js"]);
    expect(await t.query(internal.lib.getByPath, { path: "/index.html" })).toEqual(oldIndex);
    expect(await t.query(internal.lib.getByPath, { path: "/app.js" })).toBeNull();

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-new",
        expectedAssetCount: assets.length,
        spaFallback: false,
      }),
    ).resolves.toBeNull();
    expect(await t.query(internal.lib.listAssets, {})).toMatchObject([
      { path: "/index.html", deploymentId: "deploy-new" },
      { path: "/app.js", deploymentId: "deploy-new" },
    ]);
    expect(await t.query(api.lib.getCurrentDeployment, {})).toMatchObject({
      currentDeploymentId: "deploy-new",
      spaFallback: false,
    });
    const file = await t.query(components.files.lib.getByPath, {
      path: "deployments/deploy-new/index.html",
    });
    expect(file).not.toBeNull();
    expect(await t.query(internal.lib.getByPath, { path: "/index.html" })).toMatchObject({
      fileId: file?._id,
    });
    expect(await t.run(async (ctx) => await ctx.db.query("stagedAssets").collect())).toEqual([]);
  });

  test("deletes unregistered uploads and tolerates files that are already gone", async () => {
    const t = initConvexTest();
    const first = await t.action(fileStorage.store, { body: "first" });
    const alreadyMissing = await t.action(fileStorage.store, { body: "missing" });
    await t.mutation(fileStorage.remove, { storageId: alreadyMissing });
    expect(
      await t.mutation(internal.lib.deleteUploadedFiles, {
        fileStorageIds: [first, alreadyMissing],
      }),
    ).toEqual({ deleted: 1, alreadyMissing: 1, stillReferenced: 0 });
    expect(await t.action(fileStorage.read, { storageId: first })).toBeNull();
  });

  test("cleanup after a lost publish response keeps the newly live file", async () => {
    const t = initConvexTest();
    const assets = await publish(t, "deploy-ambiguous", ["/index.html"]);
    expect(
      await t.mutation(internal.lib.discardStagedDeployment, {
        deploymentId: "deploy-ambiguous",
      }),
    ).toEqual({ discarded: 0 });
    await t.mutation(internal.lib.cleanupPendingStorage, {});
    expect(
      await t.mutation(internal.lib.deleteUploadedFiles, {
        fileStorageIds: [assets[0].fileStorageId],
      }),
    ).toEqual({ deleted: 0, alreadyMissing: 0, stillReferenced: 1 });
    expect(await t.action(fileStorage.read, { storageId: assets[0].fileStorageId })).toBe(
      "deploy-ambiguous/index.html",
    );
  });

  test("rolls back child registration when another staged file belongs to the parent", async () => {
    const t = initConvexTest();
    const childStorageId = await t.action(fileStorage.store, { body: "child upload" });
    const parentStorageId = await t.run(async (ctx) => {
      // The fake backend starts each namespace's ID counter at the same value.
      await ctx.storage.store(new Blob(["unrelated parent file"]));
      return await ctx.storage.store(new Blob(["parent upload"]));
    });
    await expect(
      t.mutation(internal.lib.stageAssets, {
        assets: [
          {
            path: "/index.html",
            fileStorageId: childStorageId,
            contentType: "text/html",
            deploymentId: "deploy-failed-stage",
          },
          {
            path: "/app.js",
            fileStorageId: parentStorageId,
            contentType: "application/javascript",
            deploymentId: "deploy-failed-stage",
          },
        ],
      }),
    ).rejects.toThrow("Storage file not found");
    expect(
      await t.query(components.files.lib.getByPath, {
        path: "deployments/deploy-failed-stage/index.html",
      }),
    ).toBeNull();
    expect(await t.run(async (ctx) => await ctx.db.query("stagedAssets").collect())).toEqual([]);
    expect(await t.action(fileStorage.read, { storageId: childStorageId })).toBe("child upload");
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(parentStorageId)).not.toBeNull();
    });
    expect(
      await t.mutation(internal.lib.deleteUploadedFiles, { fileStorageIds: [childStorageId] }),
    ).toEqual({ deleted: 1, alreadyMissing: 0, stillReferenced: 0 });
  });

  test("discard prevents late publication and queues bounded file cleanup", async () => {
    const t = initConvexTest();
    await publish(t, "deploy-live", ["/index.html"]);
    const assets = await stage(t, "deploy-discarded", ["/index.html"]);
    expect(
      await t.mutation(internal.lib.discardStagedDeployment, { deploymentId: "deploy-discarded" }),
    ).toEqual({ discarded: 1 });
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-discarded",
        expectedAssetCount: 1,
      }),
    ).rejects.toThrow("Staged manifest has 0 files; expected 1");
    expect(await t.mutation(internal.lib.cleanupPendingStorage, {})).toEqual({
      processed: 1,
      deleted: 1,
      needsAnotherPass: false,
    });
    expect(await t.action(fileStorage.read, { storageId: assets[0].fileStorageId })).toBeNull();
    expect(
      await t.query(components.files.lib.getByPath, {
        path: "deployments/deploy-discarded/index.html",
      }),
    ).toBeNull();
    expect(await t.query(internal.lib.getByPath, { path: "/index.html" })).toMatchObject({
      deploymentId: "deploy-live",
    });

    await t.run(async (ctx) => {
      for (let index = 0; index < 1801; index++) {
        await ctx.db.insert("stagedAssets", {
          path: "/index.html",
          fileId: "repeated-file",
          contentType: "text/html",
          deploymentId: "deploy-oversized",
        });
      }
    });
    await expect(
      t.mutation(internal.lib.discardStagedDeployment, { deploymentId: "deploy-oversized" }),
    ).rejects.toThrow("Cannot discard more than 1800 staged files in one transaction");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("stagedAssets").collect()).toHaveLength(1801);
      expect(await ctx.db.query("pendingStorageCleanup").collect()).toEqual([]);
    });
  });

  test("rejects an incomplete manifest without changing the live deployment", async () => {
    const t = initConvexTest();
    await publish(t, "deploy-live", ["/index.html"]);
    await stage(t, "deploy-no-index", ["/only.js"]);
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-no-index",
        expectedAssetCount: 1,
      }),
    ).rejects.toThrow("must include /index.html");
    await stage(t, "deploy-truncated", ["/index.html"]);
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-truncated",
        expectedAssetCount: 2,
      }),
    ).rejects.toThrow("Staged manifest has 1 files; expected 2");
    const repeated = await stage(t, "deploy-repeated", ["/index.html"]);
    await t.mutation(internal.lib.stageAssets, { assets: repeated });
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-repeated",
        expectedAssetCount: 2,
      }),
    ).rejects.toThrow("Duplicate asset path");
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-empty",
        expectedAssetCount: 0,
      }),
    ).rejects.toThrow("integer from 1 to 1800");
    expect(await t.query(internal.lib.getByPath, { path: "/index.html" })).toMatchObject({
      deploymentId: "deploy-live",
    });
  });

  test("publishes 1,800 file references without querying or deleting child files", async () => {
    const t = initConvexTest();
    // Publication only moves parent metadata. Unresolved child references expose
    // accidental child calls while keeping this transaction-budget test small.
    await t.run(async (ctx) => {
      for (let index = 0; index < 1800; index++) {
        await ctx.db.insert("staticAssets", {
          path: index === 0 ? "/index.html" : `/old-${index}.js`,
          fileId: `old-file-${index}`,
          contentType: "text/plain",
          deploymentId: "deploy-old",
        });
        await ctx.db.insert("stagedAssets", {
          path: index === 0 ? "/index.html" : `/new-${index}.js`,
          fileId: `new-file-${index}`,
          contentType: "text/plain",
          deploymentId: "deploy-new",
        });
      }
    });
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-new",
        expectedAssetCount: 1800,
      }),
    ).resolves.toBeNull();
    await t.run(async (ctx) => {
      const current = await ctx.db.query("staticAssets").collect();
      expect(current).toHaveLength(1800);
      expect(current.every((asset) => asset.deploymentId === "deploy-new")).toBe(true);
      expect(await ctx.db.query("retiredAssets").collect()).toHaveLength(1800);
      expect(await ctx.db.query("stagedAssets").collect()).toHaveLength(0);
      expect(await ctx.db.query("pendingStorageCleanup").collect()).toHaveLength(0);
    });
    expect(await t.query(api.lib.getCurrentDeployment, {})).toMatchObject({
      currentDeploymentId: "deploy-new",
    });
  });

  test("rejects manifests above the file count and serialized metadata limits", async () => {
    const t = initConvexTest();
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-too-large",
        expectedAssetCount: 1801,
      }),
    ).rejects.toThrow("integer from 1 to 1800");
    await t.run(async (ctx) => {
      for (let index = 0; index < 1800; index++) {
        await ctx.db.insert("stagedAssets", {
          path: index === 0 ? "/index.html" : `/${index}-${"nested-path/".repeat(100)}asset.js`,
          fileId: `file-${index}`,
          contentType: "application/javascript",
          deploymentId: "deploy-too-many-bytes",
        });
      }
    });
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-too-many-bytes",
        expectedAssetCount: 1800,
      }),
    ).rejects.toThrow("above the safe limit");
    expect(await t.query(api.lib.getCurrentDeployment, {})).toBeNull();
  });

  test("removes old unregistered uploads while keeping recent uploads", async () => {
    const t = initConvexTest();
    const orphan = await t.action(fileStorage.store, { body: "orphan" });
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    const recent = await t.action(fileStorage.store, { body: "still uploading" });
    expect(
      await t.mutation(internal.lib.cleanupUnreferencedStorage, { before: Date.now(), limit: 10 }),
    ).toMatchObject({ deleted: 1, needsAnotherPass: false });
    expect(await t.action(fileStorage.read, { storageId: orphan })).toBeNull();
    expect(await t.action(fileStorage.read, { storageId: recent })).toBe("still uploading");
  });

  test("continues orphan cleanup past a full page of staged files", async () => {
    const t = initConvexTest();
    const assets = await stage(
      t,
      "deploy-still-staged",
      Array.from({ length: 128 }, (_, index) => `/asset-${index}.js`),
    );
    const orphan = await t.action(fileStorage.store, { body: "interrupted upload" });
    vi.advanceTimersByTime(1000);
    expect(
      await t.mutation(internal.lib.cleanupUnreferencedStorage, { before: Date.now() }),
    ).toEqual({ scanned: 128, deleted: 0, needsAnotherPass: true });
    expect(await t.action(fileStorage.read, { storageId: orphan })).toBe("interrupted upload");
    expect(
      await t.mutation(internal.lib.cleanupUnreferencedStorage, { before: Date.now() }),
    ).toEqual({ scanned: 1, deleted: 1, needsAnotherPass: false });
    expect(await t.action(fileStorage.read, { storageId: orphan })).toBeNull();
    expect(await t.action(fileStorage.read, { storageId: assets[0].fileStorageId })).toBe(
      "deploy-still-staged/asset-0.js",
    );
  });

  test("recovers abandoned staging without deleting a current upload", async () => {
    const t = initConvexTest();
    const abandoned = await stage(t, "deploy-abandoned", ["/index.html"]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    const recent = await stage(t, "deploy-active", ["/index.html"]);
    expect(await t.mutation(internal.lib.cleanupAbandonedStaging, {})).toEqual({
      discarded: 1,
      deletedFiles: 1,
    });
    expect(await t.action(fileStorage.read, { storageId: abandoned[0].fileStorageId })).toBeNull();
    expect(await t.action(fileStorage.read, { storageId: recent[0].fileStorageId })).not.toBeNull();
    expect(
      await t.query(components.files.lib.getByPath, {
        path: "deployments/deploy-abandoned/index.html",
      }),
    ).toBeNull();
  });

  test("keeps replaced files for seven days and never serves replaced HTML", async () => {
    const t = initConvexTest();
    const old = await publish(t, "deploy-old", ["/index.html", "/old.js", "/about.html"]);
    const retired = await t.query(internal.lib.getByPath, { path: "/old.js" });
    await publish(t, "deploy-live", ["/index.html"]);
    vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.lib.cleanupPendingStorage, {});
    await t.mutation(internal.lib.cleanupUnreferencedStorage, {});
    expect(
      await t.mutation(internal.lib.deleteUploadedFiles, {
        fileStorageIds: [old[1].fileStorageId],
      }),
    ).toMatchObject({ stillReferenced: 1 });
    expect(await t.action(fileStorage.read, { storageId: old[1].fileStorageId })).not.toBeNull();
    expect(await t.query(api.lib.resolveAssetForHttp, { path: "/old.js" })).toMatchObject({
      etag: `"${retired?.fileId}"`,
    });
    expect(await t.query(api.lib.resolveAssetForHttp, { path: "/about.html" })).toBeNull();
    const current = await t.query(internal.lib.getByPath, { path: "/index.html" });
    expect(await t.query(api.lib.resolveAssetForHttp, { path: "/dashboard" })).toMatchObject({
      etag: `"${current?.fileId}"`,
    });
    vi.advanceTimersByTime(5 * 24 * 60 * 60 * 1000);
    expect(await t.mutation(internal.lib.cleanupPendingStorage, {})).toEqual({
      processed: 3,
      deleted: 3,
      needsAnotherPass: false,
    });
    expect(await t.query(api.lib.resolveAssetForHttp, { path: "/old.js" })).toBeNull();
    expect(await t.action(fileStorage.read, { storageId: old[1].fileStorageId })).toBeNull();
  });

  test("resolves files for app-owned routes and permits a SPA fallback override", async () => {
    const t = initConvexTest();
    await publish(t, "deploy-live", ["/index.html", "/app.js"]);
    const file = await t.query(internal.lib.getByPath, { path: "/app.js" });
    const resolved = await t.query(api.lib.resolveAssetForHttp, { path: "/app.js" });
    expect(resolved).toMatchObject({
      etag: `"${file?.fileId}"`,
      contentType: "application/javascript; charset=utf-8",
    });
    expect(resolved?.storageUrl).toContain("http");
    expect(await t.query(api.lib.resolveAssetForHttp, { path: "/missing.js" })).toBeNull();
    expect(
      await t.query(api.lib.resolveAssetForHttp, { path: "/dashboard", spaFallback: false }),
    ).toBeNull();
  });
});
