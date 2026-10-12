import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { componentsGeneric, httpActionGeneric, httpRouter } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { decodeRequestPath, registerStaticRoutes, serveStaticAsset } from "./index.js";

const components = componentsGeneric() as unknown as {
  hosting: ComponentApi;
};

type TestHttpAction = {
  _handler: (ctx: { runQuery: ReturnType<typeof vi.fn> }, request: Request) => Promise<Response>;
};

function invokeHandler(handler: object, runQuery: ReturnType<typeof vi.fn>, request: Request) {
  return (handler as TestHttpAction)._handler({ runQuery }, request);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function staticHandler(path = "/") {
  const http = httpRouter();
  registerStaticRoutes(http, components.hosting, { pathPrefix: path });
  const route = http.lookup(path, "GET");
  if (!route) throw new Error(`No static route registered for ${path}`);
  return route[0];
}

describe("registerStaticRoutes", () => {
  test("keeps exact app routes ahead of the static catch-all", () => {
    const http = httpRouter();
    const authHandler = httpActionGeneric(async () => new Response("auth"));
    http.route({ path: "/auth/callback", method: "GET", handler: authHandler });

    registerStaticRoutes(http, components.hosting);

    expect(http.lookup("/auth/callback", "GET")?.[0]).toBe(authHandler);
    expect(http.lookup("/dashboard", "GET")?.[0]).not.toBe(authHandler);
  });

  test("serves a named file at the root", async () => {
    const handler = staticHandler();
    const runQuery = vi.fn().mockResolvedValue({
      storageUrl: "https://storage.example/index",
      contentType: "text/html; charset=utf-8",
      etag: '"file-id"',
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<h1>Hello</h1>")));

    const response = await invokeHandler(
      handler,
      runQuery,
      new Request("https://app.convex.site/"),
    );

    expect(runQuery).toHaveBeenCalledWith(components.hosting.lib.resolveAssetForHttp, {
      path: "/index.html",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"file-id"');
    expect(await response.text()).toBe("<h1>Hello</h1>");
  });

  test("returns a non-cacheable 503 setup page before the first upload", async () => {
    const handler = staticHandler();
    const runQuery = vi.fn().mockResolvedValue(null);

    const response = await invokeHandler(
      handler,
      runQuery,
      new Request("https://app.convex.site/"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.text()).toContain("no static files have been deployed");
  });

  test("returns the setup page at the exact compatibility prefix", async () => {
    const http = httpRouter();
    registerStaticRoutes(http, components.hosting, {
      pathPrefix: "/app/",
    });
    const handler = http.lookup("/app", "GET")?.[0];
    if (!handler) throw new Error("No exact prefixed route registered");

    const response = await invokeHandler(
      handler,
      vi.fn().mockResolvedValue(null),
      new Request("https://app.convex.site/app"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  test("decodes percent-encoded paths before resolving assets", async () => {
    const handler = staticHandler();
    const runQuery = vi.fn().mockResolvedValue(null);

    await invokeHandler(
      handler,
      runQuery,
      new Request("https://app.convex.site/docs/hello%20world.txt"),
    );

    expect(runQuery).toHaveBeenCalledWith(components.hosting.lib.resolveAssetForHttp, {
      path: "/docs/hello world.txt",
    });
  });

  test("rejects malformed percent encoding before querying the component", async () => {
    const handler = staticHandler();
    const runQuery = vi.fn();

    const response = await invokeHandler(
      handler,
      runQuery,
      new Request("https://app.convex.site/bad%ZZpath"),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(runQuery).not.toHaveBeenCalled();
  });

  test("returns an uncached 404 for a missing file", async () => {
    const handler = staticHandler();

    const response = await invokeHandler(
      handler,
      vi.fn().mockResolvedValue(null),
      new Request("https://app.convex.site/assets/missing.js"),
    );

    expect(response.status).toBe(404);
    // A CDN must not keep the 404 after the file is uploaded.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("strips a path prefix and forwards the SPA override", async () => {
    const http = httpRouter();
    registerStaticRoutes(http, components.hosting, {
      pathPrefix: "/app/",
      spaFallback: false,
    });
    const handler = http.lookup("/app/dashboard", "GET")?.[0];
    if (!handler) throw new Error("No prefixed static route registered");
    const runQuery = vi.fn().mockResolvedValue(null);

    const response = await invokeHandler(
      handler,
      runQuery,
      new Request("https://app.convex.site/app/dashboard"),
    );

    expect(runQuery).toHaveBeenCalledWith(components.hosting.lib.resolveAssetForHttp, {
      path: "/dashboard",
      spaFallback: false,
    });
    expect(response.status).toBe(404);
  });

  test("returns 304 for a weak ETag in a validator list", async () => {
    const handler = staticHandler();
    const runQuery = vi.fn().mockResolvedValue({
      storageUrl: "https://storage.example/app.js",
      contentType: "application/javascript; charset=utf-8",
      etag: '"file-id"',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await invokeHandler(
      handler,
      runQuery,
      new Request("https://app.convex.site/app.js", {
        headers: {
          "If-None-Match": '"not-current", W/"file-id"',
        },
      }),
    );

    expect(response.status).toBe(304);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("serveStaticAsset", () => {
  test("serves an exact file with the registerStaticRoutes headers", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      storageUrl: "https://storage.example/app",
      contentType: "application/javascript; charset=utf-8",
      etag: '"file-id"',
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("app()")));

    const response = await serveStaticAsset(
      { runQuery },
      components.hosting,
      new Request("https://app.convex.site/assets/app-B71cUw87.js"),
    );

    expect(runQuery).toHaveBeenCalledWith(components.hosting.lib.resolveAssetForHttp, {
      path: "/assets/app-B71cUw87.js",
      spaFallback: false,
    });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response?.headers.get("ETag")).toBe('"file-id"');
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response?.text()).toBe("app()");
  });

  test("returns null instead of a setup page or 404", async () => {
    const runQuery = vi.fn().mockResolvedValue(null);

    for (const url of ["/", "/missing.js", "/dashboard"]) {
      const response = await serveStaticAsset(
        { runQuery },
        components.hosting,
        new Request(`https://app.convex.site${url}`),
      );
      expect(response).toBeNull();
    }
    // An exact lookup: `/` is not mapped to `/index.html`.
    expect(runQuery).toHaveBeenCalledWith(components.hosting.lib.resolveAssetForHttp, {
      path: "/",
      spaFallback: false,
    });
  });

  test("serves the SPA shell only for an explicit path", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      storageUrl: "https://storage.example/index",
      contentType: "text/html; charset=utf-8",
      etag: '"index-id"',
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<div id=root>")));

    const response = await serveStaticAsset(
      { runQuery },
      components.hosting,
      new Request("https://app.convex.site/dashboard/settings"),
      { path: "/index.html" },
    );

    expect(runQuery).toHaveBeenCalledWith(components.hosting.lib.resolveAssetForHttp, {
      path: "/index.html",
      spaFallback: false,
    });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
  });

  test("forwards an explicit SPA fallback opt-in", async () => {
    const runQuery = vi.fn().mockResolvedValue(null);

    await serveStaticAsset(
      { runQuery },
      components.hosting,
      new Request("https://app.convex.site/dashboard"),
      { spaFallback: true },
    );

    expect(runQuery).toHaveBeenCalledWith(components.hosting.lib.resolveAssetForHttp, {
      path: "/dashboard",
      spaFallback: true,
    });
  });

  test("returns null for malformed percent-encoding without querying", async () => {
    const runQuery = vi.fn();

    const response = await serveStaticAsset(
      { runQuery },
      components.hosting,
      new Request("https://app.convex.site/caf%E9"),
    );

    expect(response).toBeNull();
    expect(runQuery).not.toHaveBeenCalled();
  });

  test("rejects a path without a leading slash", async () => {
    await expect(
      serveStaticAsset(
        { runQuery: vi.fn() },
        components.hosting,
        new Request("https://app.convex.site/about"),
        { path: "about/index.html" },
      ),
    ).rejects.toThrow("path must start with /");
  });

  test("revalidates a named file without fetching its bytes", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      storageUrl: "https://storage.example/app",
      contentType: "application/javascript; charset=utf-8",
      etag: '"file-id"',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const revalidated = await serveStaticAsset(
      { runQuery },
      components.hosting,
      new Request("https://app.convex.site/app.js", {
        headers: { "If-None-Match": '"file-id"' },
      }),
    );
    expect(revalidated?.status).toBe(304);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ["Asset not available", { contentType: "text/html; charset=utf-8", etag: '"file-id"' }],
    [
      "Storage error",
      {
        storageUrl: "https://storage.example/app",
        contentType: "application/javascript; charset=utf-8",
        etag: '"file-id"',
      },
    ],
  ])("returns an uncached 500 for a found file it can't read: %s", async (body, asset) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    const response = await serveStaticAsset(
      { runQuery: vi.fn().mockResolvedValue(asset) },
      components.hosting,
      new Request("https://app.convex.site/app.js"),
    );

    expect(response?.status).toBe(500);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.text()).toBe(body);
  });

  test("lets an app action fall through to its own rendering", async () => {
    const render = vi.fn(
      async (request: Request) => new Response(`rendered ${new URL(request.url).pathname}`),
    );
    const handler = httpActionGeneric(async (ctx, request) => {
      const file = await serveStaticAsset(ctx, components.hosting, request);
      if (file) return file;
      const path = decodeRequestPath(new URL(request.url).pathname);
      if (path === null || path.startsWith("/assets/")) {
        return new Response("Not Found", { status: 404 });
      }
      return await render(request);
    });
    const runQuery = vi.fn().mockResolvedValue(null);

    const page = await invokeHandler(
      handler,
      runQuery,
      new Request("https://app.convex.site/about"),
    );
    // An encoded `/assets/` path is still a missing asset, not a page.
    const staleAsset = await invokeHandler(
      handler,
      runQuery,
      new Request("https://app.convex.site/%61ssets/app-OLDHASH.js"),
    );

    expect(await page.text()).toBe("rendered /about");
    expect(staleAsset.status).toBe(404);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
