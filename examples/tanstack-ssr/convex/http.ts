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
    return await server.fetch(request);
  }),
});

export default http;
