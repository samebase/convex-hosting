import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import {
  cacheControlFor,
  decodeRequestPath,
  errorResponse,
  etagMatches,
  getMimeType,
  getSetupHtml,
} from "./serving.js";

// CONVEX_SITE_URL reflects the component's mount point (including any httpPrefix).
// We use it to strip the prefix from incoming request paths so lookups in
// the asset table remain relative to the component (e.g. `/index.html`).
export function getMountPrefix(): string {
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!siteUrl) return "";
  try {
    const pathname = decodeRequestPath(new URL(siteUrl).pathname);
    if (pathname === null) return "";
    return pathname === "/" ? "" : pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

const serveStaticFile = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const decodedPath = decodeRequestPath(url.pathname);
  if (decodedPath === null) {
    return errorResponse(400, "Bad Request");
  }
  let path = decodedPath;

  const mountPrefix = getMountPrefix();
  if (mountPrefix && path.startsWith(mountPrefix)) {
    path = path.slice(mountPrefix.length) || "/";
  }

  if (path === "" || path === "/") {
    path = "/index.html";
  }

  // One query resolves the asset: an exact match, or, when SPA fallback is
  // enabled for the current deployment, the index.html asset for an
  // extension-less miss. The fallback lookup happens inside the query so the
  // HTTP action never makes a second round-trip.
  const asset = await ctx.runQuery(internal.lib.resolveAsset, { path });

  if (!asset) {
    if (path === "/index.html") {
      return new Response(getSetupHtml(), {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "5",
        },
      });
    }
    return errorResponse(404, "Not Found");
  }

  const contentType = asset.contentType || getMimeType(path);

  const etag = `"${asset.fileId}"`;
  const ifNoneMatch = request.headers.get("If-None-Match");
  const cacheControl = cacheControlFor(path);

  if (etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl },
    });
  }

  if (!asset.storageUrl) return errorResponse(500, "Storage error");
  let response;
  try {
    response = await fetch(asset.storageUrl);
  } catch {
    return errorResponse(500, "Storage error");
  }
  if (!response.ok) return errorResponse(500, "Storage error");
  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: serveStaticFile,
});

export default http;
