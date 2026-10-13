/// <reference types="vite/client" />
// Component fixtures for lib.test.ts and http.test.ts.
import schema from "./schema.js";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api.js";
import type { AssetConfig } from "../workers-shared/utils/types.js";
import { COMPATIBILITY_DATE } from "../contract.js";

const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  return t;
}

type TestConvex = ReturnType<typeof initConvexTest>;

/** A file of a test version. */
export type TestFile = { body: string; contentType: string; immutable?: boolean };

export function testVersionId(letter: string) {
  return `v_${letter.repeat(26)}`;
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function store(t: TestConvex, body: string) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([body])));
}

/** Uploads the manifest of a version and starts it. */
export async function startTestVersion(
  t: TestConvex,
  versionId: string,
  files: Record<string, TestFile>,
  config: AssetConfig = {},
) {
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, file]) => ({
      path,
      sha256: await sha256Hex(file.body),
      size: new TextEncoder().encode(file.body).byteLength,
      contentType: file.contentType,
      immutable: file.immutable ?? false,
    })),
  );
  const manifestStorageId = await store(
    t,
    JSON.stringify({
      versionId,
      config: { compatibility_date: COMPATIBILITY_DATE, ...config },
      entries,
    }),
  );
  return await t.action(internal.lib.startVersion, { versionId, manifestStorageId });
}

/** Starts a version, records every file, and finishes it, so it is ready. */
export async function uploadTestVersion(
  t: TestConvex,
  versionId: string,
  files: Record<string, TestFile>,
  config: AssetConfig = {},
) {
  const { pending } = await startTestVersion(t, versionId, files, config);
  for (const { path } of pending) {
    const storageId = await store(t, files[path].body);
    await t.mutation(internal.lib.recordFile, { versionId, path, storageId });
  }
  return await t.action(internal.lib.finishVersion, { versionId });
}

/** Uploads a version and activates it. */
export async function deployTestVersion(
  t: TestConvex,
  versionId: string,
  files: Record<string, TestFile>,
  config: AssetConfig = {},
) {
  await uploadTestVersion(t, versionId, files, config);
  return await t.mutation(internal.lib.activate, { versionId, afterCodePush: false });
}
