import { httpRouter } from "convex/server";
import { serveSite } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

// Every method, every path, as a Cloudflare Worker without a script: a file for a path that has
// one, else the single-page fallback; another method than GET or HEAD on a file answers 405.
const site = httpAction((ctx, request) => serveSite(ctx, components.hosting, request, versionId));
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
  http.route({ pathPrefix: "/", method, handler: site });
}

export default http;
