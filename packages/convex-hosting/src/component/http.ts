import { httpRouter } from "convex/server";
import { api } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { notFound, serveRequest } from "./serving.js";

const http = httpRouter();

// The request URL keeps the mount prefix, so the version's `base_path` must name it.
http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(
    async (ctx, request) =>
      (await serveRequest(ctx, api.lib.route, request, false, async ({ storageId }) =>
        ctx.storage.get(storageId),
      )) ?? notFound(),
  ),
});

export default http;
