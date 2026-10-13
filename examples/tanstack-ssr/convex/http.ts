import { httpRouter } from "convex/server";
import { serveAsset } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const asset = await serveAsset(ctx, components.hosting, request, versionId);
    if (asset) return asset;

    // Every other path is a page. TanStack Start renders it, including its own 404 page. Loading
    // the renderer here keeps file requests fast.
    const { default: server } = await import("../dist/server/server.js");
    const page = await server.fetch(request);
    // The deployment's Cloudflare front caches answers on static-looking paths, so a rendered 404
    // for a script requested before its upload ended would stay cached after the file exists (the
    // 0.3.2 incident).
    const headers = new Headers(page.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(page.body, { status: page.status, headers });
  }),
});

export default http;
