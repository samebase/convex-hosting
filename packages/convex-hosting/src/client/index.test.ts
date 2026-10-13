/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { internal } from "../component/_generated/api.js";
import schema from "../component/schema.js";
import { serveAsset } from "./index.js";

const modules = import.meta.glob(["../component/**/*.ts", "!../component/**/*.test.ts"]);

/** The component's `route`, as an app reaches it through `components.hosting`. */
const component = { lib: { route: anyApi.lib.route } };

async function setup() {
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
  await t.mutation(internal.lib.finishDeploy, { versionId: "v1", pushed: false });
  await createVersion("v2");
  // `t.run` returns Convex values, so the response comes back as its parts.
  return (path: string, versionId = "v1") =>
    t.run(async (ctx) => {
      const url = `https://example.convex.site${path}`;
      const response = await serveAsset(ctx, component, new Request(url), versionId);
      return (
        response && {
          status: response.status,
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
          body: await response.text(),
        }
      );
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serveAsset", () => {
  test("answers a hit with the stored body and the handler's headers", async () => {
    const fetchStorage = vi.fn(async () => new Response("<h1>Home</h1>"));
    vi.stubGlobal("fetch", fetchStorage);
    const response = await (await setup())("/");
    expect(response?.status).toBe(200);
    expect(response?.contentType).toBe("text/html");
    expect(response?.body).toBe("<h1>Home</h1>");
    expect(fetchStorage).toHaveBeenCalledOnce();
  });

  test("returns null when no asset matches", async () => {
    expect(await (await setup())("/missing")).toBeNull();
  });

  test("answers 404 naming a version that does not exist or is uploading", async () => {
    const serve = await setup();
    const missing = await serve("/", "v3");
    expect(missing?.status).toBe(404);
    expect(missing?.body).toContain("v3");
    expect(missing?.cacheControl).toBe("no-store");
    const uploading = await serve("/", "v2");
    expect(uploading?.status).toBe(404);
    expect(uploading?.body).toContain("v2");
    expect(uploading?.cacheControl).toBe("no-store");
  });

  test("answers 404 when storage no longer has the file, and 502 for other failures", async () => {
    const serve = await setup();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const deleted = await serve("/");
    expect(deleted?.status).toBe(404);
    expect(deleted?.cacheControl).toBe("no-store");

    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
    const failed = await serve("/");
    expect(failed?.status).toBe(502);
    expect(failed?.cacheControl).toBe("no-store");

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect((await serve("/"))?.status).toBe(502);
  });
});
