import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { componentsGeneric, httpActionGeneric, httpRouter } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { registerStaticRoutes, serveStaticAsset } from "./index.js";

const components = componentsGeneric() as unknown as { hosting: ComponentApi };

/** Convex keeps the handler of a registered function on `_handler`. */
type Invocable = {
  _handler: (ctx: { runQuery: ReturnType<typeof vi.fn> }, input: unknown) => Promise<unknown>;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const routed = {
  handled: true,
  status: 200,
  headers: [
    { name: "content-type", value: "text/javascript" },
    { name: "etag", value: '"abc-12345678"' },
  ],
  body: { storageId: "s1", storageUrl: "https://storage.example/s1" },
};

async function invokeStaticRoute(path: string, runQuery: ReturnType<typeof vi.fn>, init = {}) {
  const http = httpRouter();
  registerStaticRoutes(http, components.hosting);
  const [handler] = http.lookup(path, "GET") ?? [];
  if (!handler) throw new Error(`No route for ${path}`);
  const request = new Request(`https://app.convex.site${path}`, init);
  return (await (handler as unknown as Invocable)._handler({ runQuery }, request)) as Response;
}

describe("registerStaticRoutes", () => {
  test("registers the prefix and the prefix without its slash, after exact app routes", () => {
    const http = httpRouter();
    const auth = httpActionGeneric(async () => new Response("auth"));
    http.route({ path: "/app/auth", method: "GET", handler: auth });
    registerStaticRoutes(http, components.hosting, { pathPrefix: "/app/" });

    expect(http.lookup("/app/auth", "GET")?.[0]).toBe(auth);
    const prefixed = http.lookup("/app/page", "GET")?.[0];
    expect(prefixed).toBeDefined();
    expect(http.lookup("/app", "GET")?.[0]).toBe(prefixed);
    expect(http.lookup("/other", "GET")).toBeNull();
  });

  test("routes through the component and streams the body from the storage URL", async () => {
    const runQuery = vi.fn().mockResolvedValue(routed);
    const fetchMock = vi.fn().mockResolvedValue(new Response("console.log(1)"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await invokeStaticRoute("/assets/app.js?x=1", runQuery, {
      headers: { "Sec-Fetch-Mode": "no-cors" },
    });

    expect(runQuery).toHaveBeenCalledWith(components.hosting.lib.route, {
      method: "GET",
      url: "https://app.convex.site/assets/app.js?x=1",
      headers: [{ name: "sec-fetch-mode", value: "no-cors" }],
      exact: false,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://storage.example/s1");
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"abc-12345678"');
    expect(await response.text()).toBe("console.log(1)");
  });

  test("reads nothing for a response without a body", async () => {
    const runQuery = vi.fn().mockResolvedValue({ ...routed, status: 304, body: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await invokeStaticRoute("/assets/app.js", runQuery);
    expect(response.status).toBe(304);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("answers 404 with no-store when the live version does not handle the request", async () => {
    const response = await invokeStaticRoute(
      "/missing.js",
      vi.fn().mockResolvedValue({ handled: false }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("answers 500 with no-store when storage fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gone", { status: 404 })));
    const response = await invokeStaticRoute("/assets/app.js", vi.fn().mockResolvedValue(routed));
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("serveStaticAsset", () => {
  test("is exact by default and returns null when the request is not handled", async () => {
    const runQuery = vi.fn().mockResolvedValue({ handled: false });
    const request = new Request("https://app.convex.site/");

    expect(await serveStaticAsset({ runQuery }, components.hosting, request)).toBeNull();
    expect(runQuery).toHaveBeenLastCalledWith(
      components.hosting.lib.route,
      expect.objectContaining({ exact: true }),
    );

    await serveStaticAsset({ runQuery }, components.hosting, request, { exact: false });
    expect(runQuery).toHaveBeenLastCalledWith(
      components.hosting.lib.route,
      expect.objectContaining({ exact: false }),
    );
  });

  test("returns the routed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("console.log(1)")));
    const response = await serveStaticAsset(
      { runQuery: vi.fn().mockResolvedValue(routed) },
      components.hosting,
      new Request("https://app.convex.site/assets/app.js"),
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("console.log(1)");
  });
});
