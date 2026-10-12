/// <reference types="vite/client" />
import { test } from "vite-plus/test";
import schema from "./schema.js";
import { convexTest } from "convex-test";
import { actionGeneric, componentsGeneric, mutationGeneric } from "convex/server";
import type { ApiFromModules } from "convex/server";
import { v } from "convex/values";
import filesSchema from "../../vendor/files/dist/component/schema.js";
export const modules = import.meta.glob("./**/*.*s");
const filesModules = import.meta.glob("../../vendor/files/src/component/**/*.ts");

// convex-test has no upload endpoint. These test-only functions put bytes in
// the child namespace while its normal registration and cleanup APIs run unchanged.
const storageFixture = {
  store: actionGeneric({
    args: { body: v.string() },
    returns: v.id("_storage"),
    handler: async (ctx, { body }) => await ctx.storage.store(new Blob([body])),
  }),
  read: actionGeneric({
    args: { storageId: v.id("_storage") },
    returns: v.union(v.string(), v.null()),
    handler: async (ctx, { storageId }) => {
      const blob = await ctx.storage.get(storageId);
      return blob === null ? null : await blob.text();
    },
  }),
  remove: mutationGeneric({
    args: { storageId: v.id("_storage") },
    returns: v.null(),
    handler: async (ctx, { storageId }) => {
      await ctx.storage.delete(storageId);
      return null;
    },
  }),
};

// @ts-expect-error The dynamic component proxy addresses the test module registered below.
export const fileStorage: ApiFromModules<{
  storageFixture: typeof storageFixture;
}>["storageFixture"] = componentsGeneric().files.storageFixture;

export function initConvexTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("files", filesSchema, {
    ...filesModules,
    "../../vendor/files/src/component/storageFixture.ts": async () => storageFixture,
  });
  return t;
}
test("setup", () => {});
