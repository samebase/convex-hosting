/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { componentsGeneric } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.useRealTimers();
});

describe("native file registry", () => {
  test("registers an existing blob once and reads its native metadata and URL", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["file contents"], { type: "text/plain" }));
    });

    const fileId = await t.mutation(api.lib.register, { path: "docs/readme.txt", storageId });
    expect(await t.mutation(api.lib.register, { path: "docs/readme.txt", storageId })).toBe(fileId);

    const native = await t.run(async (ctx) => ({
      metadata: await ctx.db.system.get("_storage", storageId),
      url: await ctx.storage.getUrl(storageId),
    }));
    const file = await t.query(api.lib.get, { fileId });
    expect(file).toEqual({
      _id: fileId,
      _creationTime: expect.any(Number),
      path: "docs/readme.txt",
      storageId,
      metadata: native.metadata,
      url: native.url,
    });
    expect(file?.metadata).toMatchObject({ size: 13 });
    expect(file?.url).toEqual(expect.any(String));
    expect(await t.query(api.lib.getByPath, { path: "docs/readme.txt" })).toEqual(file);
    expect(await t.query(api.lib.getByPath, { path: "docs/absent.txt" })).toBeNull();
    expect(await t.run(async (ctx) => await ctx.db.query("files").collect())).toHaveLength(1);
  });

  test("rejects missing blobs, including a previously registered blob that was deleted", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["removed"]));
    });
    const fileId = await t.mutation(api.lib.register, { path: "removed.txt", storageId });
    await t.run(async (ctx) => {
      await ctx.storage.delete(storageId);
    });

    await expect(t.mutation(api.lib.register, { path: "missing.txt", storageId })).rejects.toThrow(
      "Storage file not found",
    );
    await expect(t.mutation(api.lib.register, { path: "removed.txt", storageId })).rejects.toThrow(
      "Storage file not found",
    );
    expect(await t.query(api.lib.get, { fileId })).toMatchObject({
      _id: fileId,
      metadata: null,
      url: null,
    });
    expect(await t.query(api.lib.getByPath, { path: "missing.txt" })).toBeNull();
  });

  test("a child registry rejects a blob owned by its parent", async () => {
    const t = convexTest(schema, modules);
    t.registerComponent("child", schema, modules);
    const child = componentsGeneric().child;
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["parent-owned"]));
    });

    await expect(
      t.mutation(child.lib.register, { path: "foreign.txt", storageId }),
    ).rejects.toThrow("Storage file not found");
    expect(await t.query(child.lib.getByPath, { path: "foreign.txt" })).toBeNull();
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(storageId)).not.toBeNull();
    });
  });

  test("rejects a duplicate path or a second path for the same blob without changing records", async () => {
    const t = convexTest(schema, modules);
    const { first, second } = await t.run(async (ctx) => ({
      first: await ctx.storage.store(new Blob(["first"])),
      second: await ctx.storage.store(new Blob(["second"])),
    }));
    const fileId = await t.mutation(api.lib.register, { path: "original.txt", storageId: first });

    await expect(
      t.mutation(api.lib.register, { path: "original.txt", storageId: second }),
    ).rejects.toThrow("Path already exists");
    await expect(
      t.mutation(api.lib.register, { path: "alias.txt", storageId: first }),
    ).rejects.toThrow("Storage file already registered");

    expect(await t.query(api.lib.getByPath, { path: "original.txt" })).toMatchObject({
      _id: fileId,
      storageId: first,
    });
    expect(await t.query(api.lib.getByPath, { path: "alias.txt" })).toBeNull();
    await t.run(async (ctx) => {
      expect(await ctx.db.query("files").collect()).toHaveLength(1);
      expect(await ctx.storage.get(first)).not.toBeNull();
      expect(await ctx.storage.get(second)).not.toBeNull();
    });
  });

  test("renames keep file identity and storage while occupied paths reject the rename", async () => {
    const t = convexTest(schema, modules);
    const { first, second } = await t.run(async (ctx) => ({
      first: await ctx.storage.store(new Blob(["first"])),
      second: await ctx.storage.store(new Blob(["second"])),
    }));
    const fileId = await t.mutation(api.lib.register, { path: "old.txt", storageId: first });
    await t.mutation(api.lib.register, { path: "occupied.txt", storageId: second });

    await t.mutation(api.lib.rename, { fileId, path: "docs/new.txt" });
    await t.mutation(api.lib.rename, { fileId, path: "docs/new.txt" });
    expect(await t.query(api.lib.getByPath, { path: "old.txt" })).toBeNull();
    const renamed = await t.query(api.lib.get, { fileId });
    expect(renamed).toMatchObject({ _id: fileId, path: "docs/new.txt", storageId: first });
    expect(await t.query(api.lib.getByPath, { path: "docs/new.txt" })).toEqual(renamed);

    await expect(t.mutation(api.lib.rename, { fileId, path: "occupied.txt" })).rejects.toThrow(
      "Path already exists",
    );
    expect(await t.query(api.lib.get, { fileId })).toEqual(renamed);
    expect(await t.query(api.lib.getByPath, { path: "occupied.txt" })).toMatchObject({
      storageId: second,
    });
  });

  test("prefix pagination returns each matching path once and excludes neighboring prefixes", async () => {
    const t = convexTest(schema, modules);
    const paths = [
      "docs/07.txt",
      "docs2/neighbor.txt",
      "docs/03.txt",
      "doc/neighbor.txt",
      "docs/01.txt",
      "docs/05.txt",
      "docs/02.txt",
      "docs/06.txt",
      "docs/04.txt",
      "docs/\u{10FFFF}.txt",
    ];
    for (const path of paths) {
      const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob([path])));
      await t.mutation(api.lib.register, { path, storageId });
    }

    let result = await t.query(api.lib.list, {
      prefix: "docs/",
      paginationOpts: { cursor: null, numItems: 2 },
    });
    expect(result.page.map((file) => file.path)).toEqual(["docs/01.txt", "docs/02.txt"]);
    expect(result.isDone).toBe(false);
    const received = result.page.map((file) => file.path);
    for (let page = 0; page < 4 && !result.isDone; page++) {
      result = await t.query(api.lib.list, {
        prefix: "docs/",
        paginationOpts: { cursor: result.continueCursor, numItems: 2 },
      });
      expect(result.page.length).toBeLessThanOrEqual(2);
      received.push(...result.page.map((file) => file.path));
    }

    expect(result.isDone).toBe(true);
    expect(received).toEqual([
      "docs/01.txt",
      "docs/02.txt",
      "docs/03.txt",
      "docs/04.txt",
      "docs/05.txt",
      "docs/06.txt",
      "docs/07.txt",
      "docs/\u{10FFFF}.txt",
    ]);
    expect(
      (
        await t.query(api.lib.list, {
          prefix: "docs/\u{10FFFF}",
          paginationOpts: { cursor: null, numItems: 2 },
        })
      ).page.map((file) => file.path),
    ).toEqual(["docs/\u{10FFFF}.txt"]);
  });

  test("remove deletes the native blob and registry entry and permits retries", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(["delete me"])));
    const fileId = await t.mutation(api.lib.register, { path: "delete.txt", storageId });

    await t.mutation(api.lib.remove, { fileId });
    await t.mutation(api.lib.remove, { fileId });

    expect(await t.query(api.lib.get, { fileId })).toBeNull();
    expect(await t.query(api.lib.getByPath, { path: "delete.txt" })).toBeNull();
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(storageId)).toBeNull();
      expect(await ctx.db.system.get("_storage", storageId)).toBeNull();
    });
  });

  test("cleanup deletes old unregistered blobs and retains registered and recent blobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const t = convexTest(schema, modules);
    const { registered, orphan } = await t.run(async (ctx) => ({
      registered: await ctx.storage.store(new Blob(["registered"])),
      orphan: await ctx.storage.store(new Blob(["interrupted upload"])),
    }));
    const fileId = await t.mutation(api.lib.register, {
      path: "retained.txt",
      storageId: registered,
    });
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const young = await t.run(
      async (ctx) => await ctx.storage.store(new Blob(["still uploading"])),
    );
    const before = Date.now() - 60 * 60 * 1000;

    expect(await t.mutation(api.lib.cleanupUnregistered, { before })).toMatchObject({
      scanned: 3,
      deleted: 1,
      isDone: true,
      continueCursor: null,
    });
    expect(await t.query(api.lib.get, { fileId })).toMatchObject({ storageId: registered });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(registered)).not.toBeNull();
      expect(await ctx.storage.get(young)).not.toBeNull();
      expect(await ctx.storage.get(orphan)).toBeNull();
    });
  });

  test("canceling an upload deletes only an unregistered blob", async () => {
    const t = convexTest(schema, modules);
    const { unnamed, named } = await t.run(async (ctx) => ({
      unnamed: await ctx.storage.store(new Blob(["incomplete"])),
      named: await ctx.storage.store(new Blob(["registered"])),
    }));
    const fileId = await t.mutation(api.lib.register, { path: "kept.txt", storageId: named });

    expect(await t.mutation(api.lib.removeUnregistered, { storageId: unnamed })).toBe("deleted");
    expect(await t.mutation(api.lib.removeUnregistered, { storageId: unnamed })).toBe("missing");
    expect(await t.mutation(api.lib.removeUnregistered, { storageId: named })).toBe("registered");
    expect(await t.query(api.lib.get, { fileId })).toMatchObject({ storageId: named });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(unnamed)).toBeNull();
      expect(await ctx.storage.get(named)).not.toBeNull();
    });
  });

  test("bounded cleanup advances past a full registered page to reach unregistered blobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const t = convexTest(schema, modules);
    const { registered, orphans } = await t.run(async (ctx) => {
      for (let index = 0; index < 130; index++) {
        await ctx.storage.store(new Blob([`file ${index}`]));
      }
      const stored = await ctx.db.system.query("_storage").withIndex("by_id").collect();
      const registered = stored.slice(0, 128);
      for (const [index, file] of registered.entries()) {
        await ctx.db.insert("files", { path: `registered/${index}.txt`, storageId: file._id });
      }
      return {
        registered: registered.map((file) => file._id),
        orphans: stored.slice(128).map((file) => file._id),
      };
    });
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const before = Date.now() - 60 * 60 * 1000;

    const first = await t.mutation(api.lib.cleanupUnregistered, { before });
    expect(first).toEqual({
      scanned: 128,
      deleted: 0,
      isDone: false,
      continueCursor: registered[registered.length - 1],
    });
    if (first.continueCursor === null) {
      expect.fail("Cleanup ended before reaching the unregistered blobs");
    }
    expect(
      await t.mutation(api.lib.cleanupUnregistered, { before, cursor: first.continueCursor }),
    ).toEqual({
      scanned: 2,
      deleted: 2,
      isDone: true,
      continueCursor: null,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("files").collect()).toHaveLength(128);
      expect(await ctx.db.system.query("_storage").collect()).toHaveLength(128);
      for (const storageId of orphans) {
        expect(await ctx.storage.get(storageId)).toBeNull();
      }
    });
  });
});
