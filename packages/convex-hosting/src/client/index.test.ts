/// <reference types="vite-plus/client" />
import { convexTest } from "convex-test";
import { anyApi, httpRouter, ROUTABLE_HTTP_METHODS } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { siteConfig } from "../cli/site-config.js";
import type { Config } from "../component/lib.js";
import { internal } from "../component/_generated/api.js";
import schema from "../component/schema.js";
import { routeAll } from "./index.js";
import { buildAssetFiles, MARK_HEADER, type Assets } from "./manifest.js";

const modules = import.meta.glob(["../component/**/*.ts", "!../component/**/*.test.ts"]);

/** The component's public functions, as an app reaches them through `components.hosting`. */
const component = { lib: { markLive: anyApi.lib.markLive } };

const CLOUD_URL = "https://example.convex.cloud";

/**
 * Version `v1` with `/index.html` and `config`, ready, and its assets as the upload writes them. The
 * site's action runs in an HTTP action, an action context where `fetch` is allowed; convex-test
 * refuses `fetch` in `t.run`, which is a mutation. The response comes back as its parts, with the
 * number of functions that the action called.
 */
async function setup(config: Config = {}) {
  // `markLive` schedules `collect`; the tests run it with `finish`.
  vi.useFakeTimers();
  vi.stubEnv("CONVEX_CLOUD_URL", CLOUD_URL);
  const t = convexTest(schema, modules);
  const body = "<h1>Home</h1>";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const configId = await t.run((ctx) => ctx.storage.store(new Blob([JSON.stringify(config)])));
  await t.action(internal.lib.createVersion, { versionId: "v1", configId });
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([body])));
  const entry = { path: "/index.html", sha256, contentType: "text/html" };
  await t.mutation(internal.lib.recordFiles, {
    versionId: "v1",
    entries: [{ ...entry, storageId }],
  });
  await t.mutation(internal.lib.finishVersion, { versionId: "v1" });
  const assets: Assets = {
    format: 1,
    versionId: "v1",
    markToken: "token-1",
    files: await buildAssetFiles(CLOUD_URL, siteConfig(config), [
      { ...entry, url: `${CLOUD_URL}/api/storage/${storageId}` },
    ]),
  };

  const serve = (
    path: string,
    options: {
      assets?: Assets;
      render?: () => Promise<Response>;
      headers?: Record<string, string>;
      method?: string;
    } = {},
  ) =>
    t.action(async (ctx) => {
      const runMutation = vi.spyOn(ctx, "runMutation");
      const runQuery = vi.spyOn(ctx, "runQuery");
      const url = `https://example.convex.site${path}`;
      const worker = options.render === undefined ? undefined : { fetch: options.render };
      const action = routeAll({
        http: httpRouter(),
        component,
        assets: options.assets ?? assets,
        worker,
      });
      const request = new Request(url, { method: options.method, headers: options.headers });
      // @ts-expect-error httpActionGeneric keeps the function as _handler; PublicHttpAction does not declare it.
      const response: Response = await action._handler(ctx, request);
      return {
        calls: runMutation.mock.calls.length + runQuery.mock.calls.length,
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        setCookie: response.headers.getSetCookie(),
        body: await response.text(),
      };
    });
  const state = () =>
    t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("versions")
            .withIndex("by_versionId", (q) => q.eq("versionId", "v1"))
            .unique()
        )?.state.kind,
    );
  const finish = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  return { assets, serve, state, finish };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("routeAll", () => {
  test("routes the action for every method Convex routes, at every path, and returns it", async () => {
    const { assets } = await setup();
    const http = httpRouter();
    const action = routeAll({ http, component, assets });
    for (const method of ROUTABLE_HTTP_METHODS) {
      expect(http.lookup("/any/path", method)).toEqual([action, method, "/*"]);
    }
  });
});

describe("the site's action", () => {
  test("answers a hit with the stored body and the handler's headers, and calls no function", async () => {
    const fetchStorage = vi.fn(async () => new Response("<h1>Home</h1>"));
    vi.stubGlobal("fetch", fetchStorage);
    const hit = await (await setup()).serve("/");
    expect(hit.status).toBe(200);
    expect(hit.contentType).toBe("text/html");
    expect(hit.body).toBe("<h1>Home</h1>");
    expect(fetchStorage).toHaveBeenCalledOnce();
    expect(hit.calls).toBe(0);
  });

  test("the request with the site's mark token marks the version live and answers the result", async () => {
    const { assets, serve, state, finish } = await setup();
    const render = vi.fn(async () => new Response("page"));
    const marked = await serve("/.convex-hosting/mark", {
      render,
      method: "POST",
      headers: { [MARK_HEADER]: assets.markToken },
    });
    expect(marked.calls).toBe(1);
    expect(JSON.parse(marked.body)).toEqual({ versionId: "v1", result: "marked" });
    expect(marked.cacheControl).toBe("no-store");
    expect(render).not.toHaveBeenCalled();
    expect(await state()).toBe("live");
    const again = await serve("/", { headers: { [MARK_HEADER]: assets.markToken } });
    expect(JSON.parse(again.body)).toEqual({ versionId: "v1", result: "live" });
    await finish();
    expect(await state()).toBe("live");
  });

  test("a request with another mark token is an ordinary request, which calls no function", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>Home</h1>"));
    const { serve, state } = await setup();
    const other = await serve("/", { headers: { [MARK_HEADER]: "guess" } });
    expect(other.status).toBe(200);
    expect(other.body).toBe("<h1>Home</h1>");
    expect(other.calls).toBe(0);
    expect(await state()).toBe("ready");
  });

  test("a first install's assets, before its upload, answer 404 naming the version, without rendering", async () => {
    const { assets, serve } = await setup();
    const render = vi.fn(async () => new Response("page"));
    const early = await serve("/", { assets: { ...assets, files: null }, render });
    expect(early.status).toBe(404);
    expect(early.body).toBe("Version v1 of the site is not uploaded yet.");
    expect(early.cacheControl).toBe("no-store");
    expect(render).not.toHaveBeenCalled();
  });

  test("assets uploaded to another deployment answer 404 naming it, without rendering", async () => {
    const { assets, serve } = await setup();
    vi.stubEnv("CONVEX_CLOUD_URL", "https://other-dog-456.convex.cloud");
    const render = vi.fn(async () => new Response("page"));
    const elsewhere = await serve("/", { assets, render });
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body).toContain(`was uploaded to ${CLOUD_URL}, not to this deployment`);
    expect(render).not.toHaveBeenCalled();
  });

  test("assets of another format answer 500 and ask for a deploy", async () => {
    const { assets, serve } = await setup();
    // A version file that another release wrote.
    const answer = await serve("/", { assets: { ...assets, format: 0 } });
    expect(answer.status).toBe(500);
    expect(answer.body).toContain("Deploy again.");
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
    const file = await (await setup()).serve("/", { render });
    expect(file.status).toBe(200);
    expect(file.cacheControl).toBe("public, max-age=0, must-revalidate");
    expect(file.body).toBe("<h1>Home</h1>");
    expect(render).not.toHaveBeenCalled();
  });

  test("a redirect downloads nothing", async () => {
    const fetchStorage = vi.fn(async () => new Response("<h1>Home</h1>"));
    vi.stubGlobal("fetch", fetchStorage);
    const { serve } = await setup();
    const redirect = await serve("/index.html");
    expect(redirect.status).toBe(307);
    expect(fetchStorage).not.toHaveBeenCalled();
  });

  test("answers a rendered page with no-store and keeps its other headers", async () => {
    const { serve } = await setup();
    const page = await serve("/todos", {
      render: async () =>
        new Response("<h1>Todos</h1>", {
          status: 200,
          headers: [
            ["Cache-Control", "public, max-age=60"],
            ["Set-Cookie", "a=1"],
            ["Set-Cookie", "b=2"],
          ],
        }),
    });
    expect(page.status).toBe(200);
    expect(page.cacheControl).toBe("no-store");
    expect(page.setCookie).toEqual(["a=1", "b=2"]);
    expect(page.body).toBe("<h1>Todos</h1>");
    expect(page.calls).toBe(0);
  });

  test("answers a miss without render with 404 and no-store", async () => {
    const miss = await (await setup()).serve("/missing");
    expect(miss.status).toBe(404);
    expect(miss.cacheControl).toBe("no-store");
  });

  test("without render, the single-page fallback answers a request that is not a navigation", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>Home</h1>"));
    const page = await (
      await setup({ not_found_handling: "single-page-application" })
    ).serve("/about");
    expect(page.status).toBe(200);
    expect(page.body).toBe("<h1>Home</h1>");
  });

  test("with render, a request that is not a navigation and matches no file is rendered", async () => {
    const render = vi.fn(async () => new Response("<h1>About</h1>"));
    const page = await (
      await setup({ not_found_handling: "single-page-application" })
    ).serve("/about", { render });
    expect(render).toHaveBeenCalledOnce();
    expect(page.status).toBe(200);
    expect(page.body).toBe("<h1>About</h1>");
    expect(page.cacheControl).toBe("no-store");
  });
});
