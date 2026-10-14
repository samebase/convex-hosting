import { httpRouter } from "convex/server";
import { serveSite } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction((ctx, request) => serveSite(ctx, components.hosting, request, versionId)),
});

export default http;
