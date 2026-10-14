/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { internal } from "../component/_generated/api.js";
import schema from "../component/schema.js";
import { serveAsset } from "./index.js";

const modules = import.meta.glob(["../component/**/*.ts", "!../component/**/*.test.ts"]);

/** The component's public functions, as an app reaches them through `components.hosting`. */
const component = { lib: { route: anyApi.lib.route, markLive: anyApi.lib.markLive } };

async function setup() {
  // `markLive` schedules `collect`; the tests run it with `finish`.
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const entry = { path: "/index.html", body: "<h1>Home</h1>" };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.body));
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const createVersion = async (versionId: string) => {
    const configId = await t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
    await t.action(internal.lib.createVersion, { versionId, configId });
  };
  await createVersion("v1");
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([entry.body])));
  await t.mutation(internal.lib.recordFiles, {
    versionId: "v1",
    entries: [{ path: entry.path, sha256, contentType: "text/html", storageId }],
  });
  await t.mutation(internal.lib.finishVersion, { versionId: "v1" });
  await createVersion("v2");
  // `serveAsset` runs in an HTTP action, an action context where `fetch` is allowed; convex-test
  // refuses `fetch` in `t.run`, which is a mutation. The response comes back as its parts, with the
  // number of mutations that `serveAsset` called.
  const serve = (path: string, versionId = "v1") =>
    t.action(async (ctx) => {
      const runMutation = vi.spyOn(ctx, "runMutation");
      const url = `https://example.convex.site${path}`;
      const response = await serveAsset(ctx, component, new Request(url), versionId);
      return {
        mutations: runMutation.mock.calls.length,
        response: response && {
          status: response.status,
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
          body: await response.text(),
        },
      };
    });
  const state = (versionId: string) =>
    t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("versions")
            .withIndex("by_versionId", (q) => q.eq("versionId", versionId))
            .unique()
        )?.state.kind,
    );
  const finish = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, serve, state, finish };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("serveAsset", () => {
  test("answers a hit with the stored body and the handler's headers", async () => {
    const fetchStorage = vi.fn(async () => new Response("<h1>Home</h1>"));
    vi.stubGlobal("fetch", fetchStorage);
    const { response } = await (await setup()).serve("/");
    expect(response?.status).toBe(200);
    expect(response?.contentType).toBe("text/html");
    expect(response?.body).toBe("<h1>Home</h1>");
    expect(fetchStorage).toHaveBeenCalledOnce();
  });

  test("the first request marks the version live; a later request makes no mutation call", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>Home</h1>"));
    const { serve, state, finish } = await setup();
    expect(await state("v1")).toBe("ready");
    const first = await serve("/");
    expect(first.mutations).toBe(1);
    expect(first.response?.status).toBe(200);
    expect(await state("v1")).toBe("live");
    const later = await serve("/");
    expect(later.mutations).toBe(0);
    expect(later.response?.status).toBe(200);
    await finish();
    expect(await state("v1")).toBe("live");
  });

  test("concurrent first requests all mark the version live, and all answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>Home</h1>"));
    const { serve, state, finish } = await setup();
    const answers = await Promise.all([serve("/"), serve("/"), serve("/missing")]);
    expect(answers.map(({ response }) => response?.status ?? null)).toEqual([200, 200, null]);
    await finish();
    expect(await state("v1")).toBe("live");
  });

  test("returns null when no asset matches", async () => {
    expect((await (await setup()).serve("/missing")).response).toBeNull();
  });

  test("answers 404 for a version that is being deleted, and does not mark it", async () => {
    const { t, serve } = await setup();
    await t.run(async (ctx) => {
      const version = await ctx.db
        .query("versions")
        .withIndex("by_versionId", (q) => q.eq("versionId", "v1"))
        .unique();
      if (version !== null)
        await ctx.db.patch("versions", version._id, { state: { kind: "deleting" } });
    });
    const deleting = await serve("/");
    expect(deleting.response?.status).toBe(404);
    expect(deleting.response?.body).toBe("Version v1 of the site is being deleted.");
    expect(deleting.response?.cacheControl).toBe("no-store");
    expect(deleting.mutations).toBe(0);
  });

  test("answers 404 naming a version that does not exist or is uploading", async () => {
    const { serve } = await setup();
    const missing = await serve("/", "v3");
    expect(missing.response?.status).toBe(404);
    expect(missing.response?.body).toContain("v3");
    expect(missing.response?.cacheControl).toBe("no-store");
    const uploading = await serve("/", "v2");
    expect(uploading.response?.status).toBe(404);
    expect(uploading.response?.body).toContain("v2");
    expect(uploading.response?.cacheControl).toBe("no-store");
    expect(missing.mutations + uploading.mutations).toBe(0);
  });

  test("answers 404 when storage no longer has the file, and 502 for other failures", async () => {
    const { serve } = await setup();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const deleted = await serve("/");
    expect(deleted.response?.status).toBe(404);
    expect(deleted.response?.cacheControl).toBe("no-store");

    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
    const failed = await serve("/");
    expect(failed.response?.status).toBe(502);
    expect(failed.response?.cacheControl).toBe("no-store");

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect((await serve("/")).response?.status).toBe(502);
  });
});
