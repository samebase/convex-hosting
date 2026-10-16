import { httpRouter } from "convex/server";
import { serveSite } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";
// Type only, nothing is bundled: the server build imported below.
import type {} from "@samebase/convex-hosting-tanstack-start/server-build";
import server from "../dist/server/server.js";

const http = httpRouter();
const toServer = httpAction((_ctx, request) => server.fetch(request));

// Every request that is not a GET goes to the app's server (src/server.ts), as every request that
// is not a GET or HEAD goes to a Cloudflare Worker. Convex answers HEAD through GET without the body.
for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
  http.route({ pathPrefix: "/", method, handler: toServer });
}
// Exact routes for the three auth paths: the Convex Auth component holds the /auth prefix, where it
// serves the key set, and the longest prefix wins, so the catch-all above never sees them.
for (const path of ["/auth/signin", "/auth/refresh", "/auth/signout"]) {
  http.route({ path, method: "POST", handler: toServer });
}

// A file for a path that has one, the app's server for every other path, as a Cloudflare Worker
// with static assets does.
http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction((ctx, request) =>
    serveSite(ctx, components.hosting, request, versionId, () => server.fetch(request)),
  ),
});

export default http;
