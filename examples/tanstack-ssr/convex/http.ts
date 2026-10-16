import { httpRouter } from "convex/server";
import { serveSite } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";
// Type only, nothing is bundled: the server build imported below.
import type {} from "@samebase/convex-hosting-tanstack-start/server-build";
import server from "../dist/server/server.js";

const http = httpRouter();

// The app's server (src/server.ts) answers these. Exact routes win over the Convex Auth component
// mounted at /auth/.
for (const path of ["/auth/signin", "/auth/refresh", "/auth/signout"]) {
  http.route({
    path,
    method: "POST",
    handler: httpAction((_ctx, request) => server.fetch(request)),
  });
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
