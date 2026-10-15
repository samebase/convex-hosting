/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { internal } from "../component/_generated/api.js";
import schema from "../component/schema.js";
import { serveSite } from "./index.js";

const modules = import.meta.glob(["../component/**/*.ts", "!../component/**/*.test.ts"]);

/** The component's public functions, as an app reaches them through `components.hosting`. */
const component = { lib: { route: anyApi.lib.route, markLive: anyApi.lib.markLive } };

/** Version `v1` with `/index.html` and `config`, and version `v2`, still uploading. */
async function setup(config = "{}") {
  // `markLive` schedules `collect`; the tests run it with `finish`.
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const entry = { path: "/index.html", body: "<h1>Home</h1>" };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.body));
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const createVersion = async (versionId: string) => {
    const configId = await t.run((ctx) => ctx.storage.store(new Blob([config])));
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
  // `serveSite` runs in an HTTP action, an action context where `fetch` is allowed; convex-test
  // refuses `fetch` in `t.run`, which is a mutation. The response comes back as its parts, with the
  // number of mutations that `serveSite` called.
  const serve = (path: string, versionId = "v1", render?: () => Promise<Response>) =>
    t.action(async (ctx) => {
      const runMutation = vi.spyOn(ctx, "runMutation");
      const url = `https://example.convex.site${path}`;
      const response = await serveSite(ctx, component, new Request(url), versionId, render);
      return {
        mutations: runMutation.mock.calls.length,
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        setCookie: response.headers.getSetCookie(),
        body: await response.text(),
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

describe("serveSite", () => {
  test("answers a hit with the stored body and the handler's headers", async () => {
    const fetchStorage = vi.fn(async () => new Response("<h1>Home</h1>"));
    vi.stubGlobal("fetch", fetchStorage);
    const hit = await (await setup()).serve("/");
    expect(hit.status).toBe(200);
    expect(hit.contentType).toBe("text/html");
    expect(hit.body).toBe("<h1>Home</h1>");
    expect(fetchStorage).toHaveBeenCalledOnce();
  });

  test("the first request marks the version live; a later request makes no mutation call", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>Home</h1>"));
    const { serve, state, finish } = await setup();
    expect(await state("v1")).toBe("ready");
    const first = await serve("/");
    expect(first.mutations).toBe(1);
    expect(first.status).toBe(200);
    expect(await state("v1")).toBe("live");
    const later = await serve("/");
    expect(later.mutations).toBe(0);
    expect(later.status).toBe(200);
    await finish();
    expect(await state("v1")).toBe("live");
  });

  test("concurrent first requests all mark the version live, and all answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>Home</h1>"));
    const { serve, state, finish } = await setup();
    const answers = await Promise.all([serve("/"), serve("/"), serve("/missing")]);
    expect(answers.map(({ status }) => status)).toEqual([200, 200, 404]);
    await finish();
    expect(await state("v1")).toBe("live");
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
    expect(deleting.status).toBe(404);
    expect(deleting.body).toBe("Version v1 of the site is being deleted.");
    expect(deleting.cacheControl).toBe("no-store");
    expect(deleting.mutations).toBe(0);
  });

  test("answers 404 naming a version that does not exist or is uploading, without rendering", async () => {
    const { serve } = await setup();
    const render = vi.fn(async () => new Response("page"));
    const missing = await serve("/", "v3", render);
    expect(missing.status).toBe(404);
    expect(missing.body).toContain("v3");
    expect(missing.cacheControl).toBe("no-store");
    const uploading = await serve("/", "v2", render);
    expect(uploading.status).toBe(404);
    expect(uploading.body).toContain("v2");
    expect(uploading.cacheControl).toBe("no-store");
    expect(missing.mutations + uploading.mutations).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });

  test("answers 404 when storage no longer has the file, and 502 for other failures", async () => {
    const { serve } = await setup();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const deleted = await serve("/");
    expect(deleted.status).toBe(404);
    expect(deleted.cacheControl).toBe("no-store");

    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
    const failed = await serve("/");
    expect(failed.status).toBe(502);
    expect(failed.cacheControl).toBe("no-store");

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect((await serve("/")).status).toBe(502);
  });

  test("answers a file without rendering", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>Home</h1>"));
    const render = vi.fn(async () => new Response("page"));
    const file = await (await setup()).serve("/", "v1", render);
    expect(file.status).toBe(200);
    expect(file.cacheControl).toBe("public, max-age=0, must-revalidate");
    expect(file.body).toBe("<h1>Home</h1>");
    expect(render).not.toHaveBeenCalled();
  });

  test("answers a rendered page with no-store and keeps its other headers", async () => {
    const { serve } = await setup();
    const page = await serve(
      "/todos",
      "v1",
      async () =>
        new Response("<h1>Todos</h1>", {
          status: 200,
          headers: [
            ["Cache-Control", "public, max-age=60"],
            ["Set-Cookie", "a=1"],
            ["Set-Cookie", "b=2"],
          ],
        }),
    );
    expect(page.status).toBe(200);
    expect(page.cacheControl).toBe("no-store");
    expect(page.setCookie).toEqual(["a=1", "b=2"]);
    expect(page.body).toBe("<h1>Todos</h1>");
  });

  test("answers a miss without render with 404 and no-store", async () => {
    const miss = await (await setup()).serve("/missing");
    expect(miss.status).toBe(404);
    expect(miss.cacheControl).toBe("no-store");
  });

  test("without render, the single-page fallback answers a request that is not a navigation", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>Home</h1>"));
    const spa = JSON.stringify({ not_found_handling: "single-page-application" });
    const page = await (await setup(spa)).serve("/about");
    expect(page.status).toBe(200);
    expect(page.body).toBe("<h1>Home</h1>");
  });

  test("with render, a request that is not a navigation and matches no file is rendered", async () => {
    const spa = JSON.stringify({ not_found_handling: "single-page-application" });
    const render = vi.fn(async () => new Response("<h1>About</h1>"));
    const page = await (await setup(spa)).serve("/about", "v1", render);
    expect(render).toHaveBeenCalledOnce();
    expect(page.status).toBe(200);
    expect(page.body).toBe("<h1>About</h1>");
    expect(page.cacheControl).toBe("no-store");
  });
});
