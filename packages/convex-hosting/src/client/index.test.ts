/// <reference types="vite-plus/client" />
import { convexTest } from "convex-test";
import { httpRouter, ROUTABLE_HTTP_METHODS } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { siteConfig } from "../cli/site-config.js";
import type { Config } from "../component/lib.js";
import schema from "../component/schema.js";
import { routeAll } from "./index.js";
import { buildAssetFiles } from "../cli/manifest.js";
import type { Assets } from "./manifest.js";

const modules = import.meta.glob(["../component/**/*.ts", "!../component/**/*.test.ts"]);

const CLOUD_URL = "https://example.convex.cloud";

/**
 * The assets of version `v1` with `/index.html` and `config`, as the upload writes them. The site's
 * action runs in an HTTP action, an action context where `fetch` is allowed. The response comes
 * back as its parts, with the number of functions that the action called.
 */
async function setup(config: Config = {}) {
  vi.stubEnv("CONVEX_CLOUD_URL", CLOUD_URL);
  const t = convexTest(schema, modules);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("<h1>Home</h1>"));
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const assets: Assets = {
    format: 1,
    versionId: "v1",
    files: buildAssetFiles(CLOUD_URL, siteConfig(config), [
      {
        path: "/index.html",
        sha256,
        contentType: "text/html",
        url: `${CLOUD_URL}/api/storage/stored-1`,
      },
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
  return { assets, serve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("routeAll", () => {
  test("routes the action for every method Convex routes, at every path, and returns it", async () => {
    const { assets } = await setup();
    const http = httpRouter();
    const action = routeAll({ http, assets });
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
