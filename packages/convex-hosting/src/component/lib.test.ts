/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api.js";
import {
  deployTestVersion,
  initConvexTest,
  sha256Hex,
  startTestVersion,
  store,
  testVersionId,
  uploadTestVersion,
  type TestFile,
} from "./setup.test.js";

const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

const files: Record<string, TestFile> = {
  "/index.html": { body: "<h1>One</h1>", contentType: HTML },
  "/assets/app-1.js": { body: "console.log(1)", contentType: JS, immutable: true },
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

function route(t: ReturnType<typeof initConvexTest>, path: string) {
  return t.query(api.lib.route, {
    method: "GET",
    url: `https://app.convex.site${path}`,
    headers: [],
    exact: false,
  });
}

describe("upload", () => {
  test("starts, records with the digest check, finishes, and activates", async () => {
    const t = initConvexTest();
    const versionId = testVersionId("a");

    const started = await startTestVersion(t, versionId, files);
    expect(started).toEqual({
      state: "uploading",
      pending: [
        { path: "/index.html", sha256: await sha256Hex("<h1>One</h1>") },
        { path: "/assets/app-1.js", sha256: await sha256Hex("console.log(1)") },
      ],
    });
    // The manifest object is gone; only test files remain in storage afterwards.
    expect(await t.run(async (ctx) => await ctx.db.system.query("_storage").collect())).toEqual([]);
    expect(await t.action(internal.lib.finishVersion, { versionId })).toMatchObject({
      state: "uploading",
      // In path order.
      pending: [{ path: "/assets/app-1.js" }, { path: "/index.html" }],
    });

    const wrong = await store(t, "console.log(2)");
    expect(
      await t.mutation(internal.lib.recordFile, {
        versionId,
        path: "/assets/app-1.js",
        storageId: wrong,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("/assets/app-1.js") });
    expect(await t.run(async (ctx) => await ctx.db.system.get("_storage", wrong))).toBeNull();

    for (const [path, file] of Object.entries(files)) {
      const storageId = await store(t, file.body);
      expect(await t.mutation(internal.lib.recordFile, { versionId, path, storageId })).toEqual({
        ok: true,
      });
      // A repeat with the same object is a no-op.
      expect(await t.mutation(internal.lib.recordFile, { versionId, path, storageId })).toEqual({
        ok: true,
      });
    }

    expect(await t.action(internal.lib.finishVersion, { versionId })).toEqual({
      state: "ready",
      pending: [],
    });
    expect(await t.action(internal.lib.finishVersion, { versionId })).toEqual({
      state: "ready",
      pending: [],
    });
    expect(await t.query(api.lib.getLiveVersion, {})).toBeNull();

    expect(await t.mutation(internal.lib.activate, { versionId, afterCodePush: true })).toEqual({
      previousVersionId: null,
    });
    expect(await t.mutation(internal.lib.activate, { versionId, afterCodePush: true })).toEqual({
      previousVersionId: versionId,
    });
    expect(await t.query(api.lib.getLiveVersion, {})).toEqual({ versionId, liveAt: T0 });
  });

  test("a repeated start continues, and a start of a ready version returns ready", async () => {
    const t = initConvexTest();
    const versionId = testVersionId("a");
    await startTestVersion(t, versionId, files);
    const storageId = await store(t, files["/index.html"].body);
    await t.mutation(internal.lib.recordFile, { versionId, path: "/index.html", storageId });

    expect(await startTestVersion(t, versionId, files)).toEqual({
      state: "uploading",
      pending: [{ path: "/assets/app-1.js", sha256: await sha256Hex("console.log(1)") }],
    });
    const second = await store(t, files["/assets/app-1.js"].body);
    await t.mutation(internal.lib.recordFile, {
      versionId,
      path: "/assets/app-1.js",
      storageId: second,
    });
    await t.action(internal.lib.finishVersion, { versionId });
    expect(await startTestVersion(t, versionId, files)).toEqual({ state: "ready", pending: [] });
  });

  test("a different manifest for the same version id fails", async () => {
    const t = initConvexTest();
    const versionId = testVersionId("a");
    await startTestVersion(t, versionId, files);
    await expect(
      startTestVersion(t, versionId, {
        "/index.html": { body: "<h1>Two</h1>", contentType: HTML },
      }),
    ).rejects.toThrow("exists with a different manifest");
  });

  test("a second object for a recorded entry is deleted", async () => {
    const t = initConvexTest();
    const versionId = testVersionId("a");
    await startTestVersion(t, versionId, files);
    const first = await store(t, files["/index.html"].body);
    const second = await store(t, files["/index.html"].body);
    await t.mutation(internal.lib.recordFile, { versionId, path: "/index.html", storageId: first });
    expect(
      await t.mutation(internal.lib.recordFile, {
        versionId,
        path: "/index.html",
        storageId: second,
      }),
    ).toEqual({ ok: true });
    expect(await t.run(async (ctx) => await ctx.db.system.get("_storage", second))).toBeNull();
    expect(await t.run(async (ctx) => await ctx.db.system.get("_storage", first))).not.toBeNull();
  });

  test("an immutable path with other bytes than a ready version fails", async () => {
    const t = initConvexTest();
    await uploadTestVersion(t, testVersionId("a"), files);
    await expect(
      startTestVersion(t, testVersionId("b"), {
        "/assets/app-1.js": { body: "console.log(2)", contentType: JS, immutable: true },
      }),
    ).rejects.toThrow("has different bytes");
  });

  test("finishVersion fails when another upload became ready with other immutable bytes", async () => {
    const t = initConvexTest();
    // Both start before either is ready, so startVersion finds no conflict.
    await startTestVersion(t, testVersionId("a"), files);
    const other = {
      "/assets/app-1.js": { body: "console.log(2)", contentType: JS, immutable: true },
    };
    await startTestVersion(t, testVersionId("b"), other);
    await uploadTestVersion(t, testVersionId("a"), files);

    const versionId = testVersionId("b");
    const storageId = await store(t, "console.log(2)");
    await t.mutation(internal.lib.recordFile, { versionId, path: "/assets/app-1.js", storageId });
    await expect(t.action(internal.lib.finishVersion, { versionId })).rejects.toThrow(
      "different bytes at these immutable paths: /assets/app-1.js",
    );
  });

  test("finishVersion checks a version in batches", async () => {
    const t = initConvexTest();
    const versionId = testVersionId("a");
    const many: Record<string, TestFile> = {};
    for (let index = 0; index < 501; index++) {
      many[`/file-${String(index).padStart(3, "0")}.txt`] = {
        body: `file ${index}`,
        contentType: "text/plain",
      };
    }
    await startTestVersion(t, versionId, many);
    expect((await t.action(internal.lib.finishVersion, { versionId })).pending).toHaveLength(501);

    for (const [path, file] of Object.entries(many).slice(0, 500)) {
      const storageId = await store(t, file.body);
      await t.mutation(internal.lib.recordFile, { versionId, path, storageId });
    }
    // The only file left is in the second batch.
    expect(await t.action(internal.lib.finishVersion, { versionId })).toMatchObject({
      state: "uploading",
      pending: [{ path: "/file-500.txt" }],
    });

    const storageId = await store(t, "file 500");
    await t.mutation(internal.lib.recordFile, { versionId, path: "/file-500.txt", storageId });
    expect(await t.action(internal.lib.finishVersion, { versionId })).toEqual({
      state: "ready",
      pending: [],
    });
    const entries = await t.run(async (ctx) => await ctx.db.query("entries").collect());
    expect(entries.every((entry) => entry.ready)).toBe(true);
  });

  test("the manifest is checked", async () => {
    const t = initConvexTest();
    const versionId = testVersionId("a");
    const manifest = (entries: unknown[], config: object = {}) =>
      store(t, JSON.stringify({ versionId, config, entries }));
    const entry = {
      path: "/a.txt",
      sha256: await sha256Hex("a"),
      size: 1,
      contentType: "text/plain",
      immutable: false,
    };
    await expect(
      t.action(internal.lib.startVersion, {
        versionId,
        manifestStorageId: await manifest([entry, entry]),
      }),
    ).rejects.toThrow("duplicate paths");
    await expect(
      t.action(internal.lib.startVersion, {
        versionId,
        manifestStorageId: await manifest([entry], { compatibility_date: "2024-01-01" }),
      }),
    ).rejects.toThrow("compatibility_date");
    await expect(
      t.action(internal.lib.startVersion, {
        versionId: testVersionId("b"),
        manifestStorageId: await manifest([entry]),
      }),
    ).rejects.toThrow("not v_bbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  test("activate needs a ready version and marks the previous one superseded", async () => {
    const t = initConvexTest();
    await startTestVersion(t, testVersionId("a"), files);
    await expect(
      t.mutation(internal.lib.activate, { versionId: testVersionId("a"), afterCodePush: false }),
    ).rejects.toThrow("is uploading, not ready");

    await deployTestVersion(t, testVersionId("b"), files);
    vi.setSystemTime(T0 + 1000);
    expect(await deployTestVersion(t, testVersionId("c"), files)).toEqual({
      previousVersionId: testVersionId("b"),
    });
    const versions = await t.run(async (ctx) => await ctx.db.query("versions").collect());
    expect(versions.find((version) => version.versionId === testVersionId("b"))).toMatchObject({
      liveAt: T0,
      supersededAt: T0 + 1000,
    });
  });
});

describe("lookups", () => {
  test("nothing of a superseded version is served", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), {
      "/assets/old.js": { body: "old", contentType: JS, immutable: true },
    });
    vi.setSystemTime(T0 + 1000);
    await deployTestVersion(t, testVersionId("b"), files);

    expect(await route(t, "/assets/app-1.js")).toMatchObject({ handled: true, status: 200 });
    expect(await route(t, "/assets/old.js")).toEqual({ handled: false });
  });

  test("an immutable entry of a ready version newer than live", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), files);
    vi.setSystemTime(T0 + 1000);
    // Pushed but not activated yet, or its activation failed.
    await uploadTestVersion(t, testVersionId("b"), {
      "/assets/new.js": { body: "new", contentType: JS, immutable: true },
      "/new.txt": { body: "new", contentType: "text/plain" },
    });

    const found = await route(t, "/assets/new.js");
    expect(found).toMatchObject({ handled: true, status: 200, body: { contentType: JS } });
    // A mutable path never falls back to another version.
    expect(await route(t, "/new.txt")).toEqual({ handled: false });
  });

  test("finds a ready entry behind many unfinished uploads of the same path", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("k"), files);
    vi.setSystemTime(T0 + 1000);
    const next = { "/assets/next.js": { body: "next", contentType: JS, immutable: true } };
    await uploadTestVersion(t, testVersionId("a"), next);
    for (const letter of "bcdefghij") await startTestVersion(t, testVersionId(letter), next);

    expect(await route(t, "/assets/next.js")).toMatchObject({ handled: true, status: 200 });
    await expect(
      startTestVersion(t, testVersionId("l"), {
        "/assets/next.js": { body: "other", contentType: JS, immutable: true },
      }),
    ).rejects.toThrow(`version ${testVersionId("a")} has different bytes`);
  });

  test("an immutable path with other bytes than the live version fails", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), files);
    vi.setSystemTime(T0 + 1000);
    await expect(
      startTestVersion(t, testVersionId("b"), {
        "/assets/app-1.js": { body: "console.log(2)", contentType: JS, immutable: true },
      }),
    ).rejects.toThrow(`version ${testVersionId("a")} has different bytes`);
  });

  test("nothing from an uploading or deleting version", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), files);
    vi.setSystemTime(T0 + 1000);
    const versionId = testVersionId("b");
    await startTestVersion(t, versionId, {
      "/assets/new.js": { body: "new", contentType: JS, immutable: true },
    });
    const storageId = await store(t, "new");
    await t.mutation(internal.lib.recordFile, { versionId, path: "/assets/new.js", storageId });
    expect(await route(t, "/assets/new.js")).toEqual({ handled: false });

    await t.action(internal.lib.finishVersion, { versionId });
    expect(await route(t, "/assets/new.js")).toMatchObject({ handled: true, status: 200 });

    await t.run(async (ctx) => {
      const version = await ctx.db
        .query("versions")
        .withIndex("by_versionId", (q) => q.eq("versionId", versionId))
        .unique();
      if (version) await ctx.db.patch("versions", version._id, { state: "deleting" });
    });
    expect(await route(t, "/assets/new.js")).toEqual({ handled: false });
  });

  test("the same bytes with two content types get two ETags", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), {
      "/a.txt": { body: "same", contentType: "text/plain" },
      "/a.json": { body: "same", contentType: "application/json" },
    });
    const etag = async (path: string) => {
      const result = await route(t, path);
      return result.handled ? result.headers.find(({ name }) => name === "etag")?.value : null;
    };
    const sha256 = await sha256Hex("same");
    expect(await etag("/a.txt")).toBe(`"${sha256}-${(await sha256Hex("text/plain")).slice(0, 8)}"`);
    expect(await etag("/a.json")).not.toBe(await etag("/a.txt"));
  });
});

describe("cleanup", () => {
  async function versionStates(t: ReturnType<typeof initConvexTest>) {
    const versions = await t.run(async (ctx) => await ctx.db.query("versions").collect());
    return Object.fromEntries(versions.map((version) => [version.versionId, version.state]));
  }

  test("deletes a superseded file-only version at the next run and keeps the live one", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), files);
    vi.setSystemTime(T0 + 1000);
    await deployTestVersion(t, testVersionId("b"), {
      "/index.html": { body: "<h1>Two</h1>", contentType: HTML },
    });

    expect(await t.mutation(internal.lib.cleanup, {})).toEqual({ done: true });
    expect(await versionStates(t)).toEqual({ [testVersionId("b")]: "ready" });
    const entries = await t.run(async (ctx) => await ctx.db.query("entries").collect());
    expect(entries.map((entry) => entry.versionId)).toEqual([testVersionId("b")]);
    const objects = await t.run(async (ctx) => await ctx.db.system.query("_storage").collect());
    expect(objects).toHaveLength(1);
  });

  test("keeps a superseded code-push version until a later code push and deletes it right after", async () => {
    const t = initConvexTest();
    await uploadTestVersion(t, testVersionId("a"), files);
    await t.mutation(internal.lib.activate, { versionId: testVersionId("a"), afterCodePush: true });
    vi.setSystemTime(T0 + 1000);
    // A plain upload: the backend still runs the renderer of version a.
    await deployTestVersion(t, testVersionId("b"), files);

    await t.mutation(internal.lib.cleanup, {});
    expect(await versionStates(t)).toEqual({
      [testVersionId("a")]: "ready",
      [testVersionId("b")]: "ready",
    });

    vi.setSystemTime(T0 + 2000);
    await uploadTestVersion(t, testVersionId("c"), files);
    await t.mutation(internal.lib.activate, { versionId: testVersionId("c"), afterCodePush: true });
    await t.mutation(internal.lib.cleanup, {});
    expect(await versionStates(t)).toEqual({ [testVersionId("c")]: "ready" });
  });

  test("keeps a never-live version until a later code push", async () => {
    const t = initConvexTest();
    await uploadTestVersion(t, testVersionId("a"), files);
    await t.mutation(internal.lib.activate, { versionId: testVersionId("a"), afterCodePush: true });
    vi.setSystemTime(T0 + 1000);
    // Its push succeeded and its activation failed: its renderer may be live.
    await uploadTestVersion(t, testVersionId("b"), files);
    vi.setSystemTime(T0 + 2000);
    // A later file-only activation does not replace the renderer.
    await deployTestVersion(t, testVersionId("c"), files);

    await t.mutation(internal.lib.cleanup, {});
    expect(await versionStates(t)).toEqual({
      [testVersionId("a")]: "ready",
      [testVersionId("b")]: "ready",
      [testVersionId("c")]: "ready",
    });

    vi.setSystemTime(T0 + 3000);
    await uploadTestVersion(t, testVersionId("d"), files);
    await t.mutation(internal.lib.activate, { versionId: testVersionId("d"), afterCodePush: true });
    await t.mutation(internal.lib.cleanup, {});
    expect(await versionStates(t)).toEqual({ [testVersionId("d")]: "ready" });
  });

  test("keeps a code-push version after a file-only rollback to it is superseded", async () => {
    const t = initConvexTest();
    await uploadTestVersion(t, testVersionId("a"), files);
    await t.mutation(internal.lib.activate, { versionId: testVersionId("a"), afterCodePush: true });
    vi.setSystemTime(T0 + DAY);
    await deployTestVersion(t, testVersionId("b"), files);
    vi.setSystemTime(T0 + 2 * DAY);
    // A file-only rollback to a, then another plain upload: the backend still runs renderer a.
    await t.mutation(internal.lib.activate, {
      versionId: testVersionId("a"),
      afterCodePush: false,
    });
    vi.setSystemTime(T0 + 3 * DAY);
    await deployTestVersion(t, testVersionId("c"), files);

    vi.setSystemTime(T0 + 30 * DAY);
    await t.mutation(internal.lib.cleanup, {});
    expect(await versionStates(t)).toEqual({
      [testVersionId("a")]: "ready",
      [testVersionId("c")]: "ready",
    });
  });

  test("reads small version rows, because configs live in their own table", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), files);
    const config = JSON.stringify({ base_path: `/${"x".repeat(256 * 1024 - 40)}/` });
    await t.run(async (ctx) => {
      for (let index = 0; index < 205; index++) {
        const versionId = `v_${index}`;
        await ctx.db.insert("versions", {
          versionId,
          state: "ready",
          manifestSha256: "",
          entryCount: 0,
          createdAt: T0,
          liveAt: T0,
          supersededAt: T0,
        });
        await ctx.db.insert("versionConfigs", { versionId, config });
      }
    });
    // One cleanup call reads at most 200 version rows; Convex stops a transaction at 16 MiB read.
    const page = await t.run(async (ctx) => await ctx.db.query("versions").take(200));
    const pageBytes = page.reduce((total, row) => total + JSON.stringify(row).length, 0);
    expect(pageBytes).toBeLessThan(64 * 1024);
    expect(200 * config.length).toBeGreaterThan(16 * 1024 * 1024);

    vi.setSystemTime(T0 + 8 * DAY);
    let done = false;
    for (let call = 0; call < 20 && !done; call++) {
      ({ done } = await t.mutation(internal.lib.cleanup, {}));
    }
    expect(done).toBe(true);
    expect(await versionStates(t)).toEqual({ [testVersionId("a")]: "ready" });
    const configs = await t.run(async (ctx) => await ctx.db.query("versionConfigs").collect());
    expect(configs.map((row) => row.versionId)).toEqual([testVersionId("a")]);
  });

  test("checks the versions after the first page in later calls", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), files);
    // 200 never-activated versions that no code push has replaced, then 5 expired ones.
    await t.run(async (ctx) => {
      for (let index = 0; index < 205; index++) {
        const expired = index >= 200;
        await ctx.db.insert("versions", {
          versionId: `v_${index}`,
          state: "ready",
          manifestSha256: "",
          entryCount: 0,
          createdAt: T0,
          ...(expired ? { liveAt: T0, supersededAt: T0 } : {}),
        });
      }
    });

    vi.setSystemTime(T0 + 8 * DAY);
    expect(await t.mutation(internal.lib.cleanup, {})).toEqual({ done: false });
    expect(await t.mutation(internal.lib.cleanup, {})).toEqual({ done: true });
    const states = await versionStates(t);
    expect(Object.keys(states)).toHaveLength(201);
    expect(states).not.toHaveProperty("v_200");
    expect(states).toHaveProperty("v_199", "ready");
  });

  test("marks a version deleting first and finishes in later calls", async () => {
    const t = initConvexTest();
    const many: Record<string, TestFile> = {};
    for (let index = 0; index < 250; index++) {
      many[`/file-${index}.txt`] = { body: `file ${index}`, contentType: "text/plain" };
    }
    await deployTestVersion(t, testVersionId("a"), many);
    vi.setSystemTime(T0 + 1000);
    await deployTestVersion(t, testVersionId("b"), files);

    vi.setSystemTime(T0 + 9 * DAY);
    expect(await t.mutation(internal.lib.cleanup, {})).toEqual({ done: false });
    expect(await versionStates(t)).toMatchObject({ [testVersionId("a")]: "deleting" });
    await expect(
      t.mutation(internal.lib.activate, { versionId: testVersionId("a"), afterCodePush: false }),
    ).rejects.toThrow("is deleting");
    const scheduled = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.map((job) => job.name)).toEqual(["lib:cleanup"]);

    expect(await t.mutation(internal.lib.cleanup, {})).toEqual({ done: true });
    expect(await versionStates(t)).toEqual({ [testVersionId("b")]: "ready" });
  });

  test("deletes at most 25 versions with their configs per call", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), files);
    const config = JSON.stringify({ base_path: `/${"x".repeat(256 * 1024 - 40)}/` });
    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index++) {
        const versionId = `v_${index}`;
        await ctx.db.insert("versions", {
          versionId,
          state: "ready",
          manifestSha256: "",
          entryCount: 0,
          createdAt: T0,
          liveAt: T0,
          supersededAt: T0,
        });
        await ctx.db.insert("versionConfigs", { versionId, config });
      }
    });
    const remaining = async () =>
      (await t.run(async (ctx) => await ctx.db.query("versionConfigs").collect())).length;

    vi.setSystemTime(T0 + 8 * DAY);
    const results = [];
    for (let call = 0; call < 3; call++) {
      results.push((await t.mutation(internal.lib.cleanup, {})).done);
      // 25 configs of 256 KiB per call stay below Convex's 16 MiB read limit.
      expect(await remaining()).toBe(Math.max(1, 61 - 25 * (call + 1)));
    }
    expect(results).toEqual([false, false, true]);
    expect(await versionStates(t)).toEqual({ [testVersionId("a")]: "ready" });
  });

  test("scans storage in batches and continues where it stopped", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 250; index++) await ctx.storage.store(new Blob([`${index}`]));
    });
    const count = async () =>
      (await t.run(async (ctx) => await ctx.db.system.query("_storage").collect())).length;

    vi.setSystemTime(T0 + 2 * DAY);
    await t.mutation(internal.lib.cleanup, {});
    expect(await count()).toBe(50);
    await t.mutation(internal.lib.cleanup, {});
    expect(await count()).toBe(0);
  });

  test("deletes an unreferenced object and an abandoned upload older than a day", async () => {
    const t = initConvexTest();
    await deployTestVersion(t, testVersionId("a"), files);
    const orphan = await store(t, "orphan");
    await startTestVersion(t, testVersionId("b"), files);
    vi.setSystemTime(T0 + DAY + 1);
    const young = await store(t, "young");

    await t.mutation(internal.lib.cleanup, {});
    const objects = await t.run(async (ctx) => await ctx.db.system.query("_storage").collect());
    const ids = objects.map((object) => object._id);
    expect(ids).not.toContain(orphan);
    expect(ids).toContain(young);
    expect(ids).toHaveLength(3);
    expect(await versionStates(t)).toEqual({ [testVersionId("a")]: "ready" });
  });
});
