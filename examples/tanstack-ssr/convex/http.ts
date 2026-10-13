import { httpRouter } from "convex/server";
import { serveStaticAsset } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    // Uploaded files first: scripts, styles, and everything in public/. The
    // lookup is exact, so `/` and every other page path continue below.
    const file = await serveStaticAsset(ctx, components.hosting, request);
    if (file) return file;

    // Every other path is a page. TanStack Start renders it, including its own
    // 404 page, which a missing script also gets. Loading the renderer here
    // keeps file requests fast. Copy the headers, which may be immutable on
    // this response.
    const { default: server } = await import("../dist/server/server.js");
    const rendered = await server.fetch(request);
    const headers = new Headers(rendered.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(rendered.body, {
      status: rendered.status,
      statusText: rendered.statusText,
      headers,
    });
  }),
});

export default http;
