import {
  httpActionGeneric,
  queryGeneric,
  type GenericActionCtx,
  type GenericDataModel,
  type HttpRouter,
} from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  cacheControlFor,
  decodeRequestPath,
  errorResponse,
  etagMatches,
  getMimeType,
  getSetupHtml,
} from "../component/serving.js";

const deploymentInfoValidator = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  currentDeploymentId: v.string(),
  deployedAt: v.number(),
  spaFallback: v.optional(v.boolean()),
});

/** The parts of an action context needed to serve a static file. */
type AssetServingCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery">;

/**
 * Register app-owned HTTP routes for the hosted site.
 *
 * Prefer mounting the component's own HTTP routes when it can own the URL
 * prefix. Use this compatibility mode when existing app HTTP routes must stay
 * at the same root. Exact app routes take precedence over this catch-all.
 * Assets and deployment state still live in the component.
 *
 * @example
 * ```typescript
 * // convex/convex.config.ts
 * const app = defineApp();
 * app.use(hosting); // no httpPrefix: the app owns HTTP routing
 *
 * // convex/http.ts
 * const http = httpRouter();
 * auth.addHttpRoutes(http);
 * registerStaticRoutes(http, components.hosting);
 * export default http;
 * ```
 */
export function registerStaticRoutes(
  http: HttpRouter,
  component: ComponentApi,
  {
    pathPrefix = "/",
    spaFallback,
  }: {
    /** URL prefix where the app should serve static files. */
    pathPrefix?: string;
    /** Override the deployment's SPA fallback setting. */
    spaFallback?: boolean;
  } = {},
) {
  if (!pathPrefix.startsWith("/")) {
    throw new Error("pathPrefix must start with /");
  }

  const normalizedPrefix = pathPrefix === "/" ? "" : pathPrefix.replace(/\/$/, "");

  const serveStaticFile = httpActionGeneric(async (ctx, request) => {
    const decodedPath = decodeRequestPath(new URL(request.url).pathname);
    if (decodedPath === null) {
      return errorResponse(400, "Bad Request");
    }
    let path = decodedPath;

    if (normalizedPrefix && path.startsWith(normalizedPrefix)) {
      path = path.slice(normalizedPrefix.length) || "/";
    }
    if (path === "" || path === "/") {
      path = "/index.html";
    }

    const response = await serveAsset(ctx, component, request, path, {
      spaFallback,
    });
    if (response) return response;

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
  });

  http.route({
    pathPrefix: pathPrefix === "/" ? "/" : `${normalizedPrefix}/`,
    method: "GET",
    handler: serveStaticFile,
  });

  if (normalizedPrefix) {
    http.route({
      path: normalizedPrefix,
      method: "GET",
      handler: serveStaticFile,
    });
  }
}

/**
 * Serve an uploaded static file from your own HTTP action, or return null when
 * no file matches so the action can continue with its own routing: server
 * rendering, prerendered pages, redirects.
 *
 * Found files get the same response as `registerStaticRoutes`: content type,
 * cache headers, and ETag revalidation. A found file
 * whose storage can't be read gets a 500 response. A request path with
 * malformed percent-encoding matches no file, so it returns null.
 *
 * The lookup is exact by default. `/` is not mapped to `/index.html`, and there
 * is no SPA fallback, so the SPA shell never answers for a route your action
 * handles. To serve the shell, pass `{ path: "/index.html" }`. When your route
 * has a prefix, pass `path` with the prefix removed.
 *
 * @example
 * ```typescript
 * // convex/http.ts
 * const http = httpRouter();
 * http.route({
 *   pathPrefix: "/",
 *   method: "GET",
 *   handler: httpAction(async (ctx, request) => {
 *     const file = await serveStaticAsset(ctx, components.hosting, request);
 *     if (file) return file;
 *     return await renderPage(request);
 *   }),
 * });
 * export default http;
 * ```
 */
export async function serveStaticAsset(
  ctx: AssetServingCtx,
  component: ComponentApi,
  request: Request,
  {
    path,
    spaFallback = false,
  }: {
    /**
     * Decoded file path to look up, starting with `/`, such as
     * `/about/index.html`. Defaults to the decoded request path.
     */
    path?: string;
    /** Serve `/index.html` for a missing path without a file extension. */
    spaFallback?: boolean;
  } = {},
): Promise<Response | null> {
  if (path !== undefined && !path.startsWith("/")) {
    throw new Error("path must start with /");
  }
  const filePath = path ?? decodeRequestPath(new URL(request.url).pathname);
  if (filePath === null) return null;
  return await serveAsset(ctx, component, request, filePath, {
    spaFallback,
  });
}

export { decodeRequestPath };

/**
 * Serve the uploaded file at `path` (decoded, relative to the mount prefix),
 * or return null when no file matches. An undefined `spaFallback` uses the
 * deployment's stored setting.
 */
async function serveAsset(
  ctx: AssetServingCtx,
  component: ComponentApi,
  request: Request,
  path: string,
  {
    spaFallback,
  }: {
    spaFallback: boolean | undefined;
  },
): Promise<Response | null> {
  const asset = await ctx.runQuery(component.lib.resolveAssetForHttp, {
    path,
    ...(spaFallback === undefined ? {} : { spaFallback }),
  });
  if (!asset) return null;

  const contentType = asset.contentType || getMimeType(path);
  const cacheControl = cacheControlFor(path);

  if (!asset.storageUrl) {
    return errorResponse(500, "Asset not available");
  }

  if (etagMatches(request.headers.get("If-None-Match"), asset.etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: asset.etag, "Cache-Control": cacheControl },
    });
  }

  const storageResponse = await fetch(asset.storageUrl);
  if (!storageResponse.ok || !storageResponse.body) {
    return errorResponse(500, "Storage error");
  }

  return new Response(storageResponse.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      ETag: asset.etag,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Expose a query that clients can subscribe to for live reload on deploy.
 * This is only needed if you use `UpdateBanner` / `useDeploymentUpdates` from
 * `@samebase/convex-hosting/react`. If you don't surface deployment updates
 * in your app, you don't need to call this.
 *
 * @example
 * ```typescript
 * // convex/hosting.ts
 * import { exposeDeploymentQuery } from "@samebase/convex-hosting";
 * import { components } from "./_generated/api";
 *
 * export const { getCurrentDeployment } = exposeDeploymentQuery(
 *   components.hosting,
 * );
 * ```
 */
export function exposeDeploymentQuery(component: ComponentApi) {
  return {
    getCurrentDeployment: queryGeneric({
      args: {},
      returns: v.union(deploymentInfoValidator, v.null()),
      handler: async (ctx) => await ctx.runQuery(component.lib.getCurrentDeployment, {}),
    }),
  };
}

/**
 * Derive the Convex cloud URL from a `.convex.site` hostname.
 * Useful when your frontend is served by this component and needs
 * to connect to its own Convex backend without an explicit env var.
 *
 * @example
 * ```typescript
 * import { getConvexUrl } from "@samebase/convex-hosting";
 *
 * const convexUrl = import.meta.env.VITE_CONVEX_URL ?? getConvexUrl();
 * const convex = new ConvexReactClient(convexUrl);
 * ```
 */
export function getConvexUrl(): string {
  if (typeof window === "undefined") {
    throw new Error("getConvexUrl() can only be called in a browser context");
  }
  if (window.location.hostname.endsWith(".convex.site")) {
    return `https://${window.location.hostname.replace(".convex.site", ".convex.cloud")}`;
  }
  throw new Error("Unable to derive Convex URL. Please set VITE_CONVEX_URL environment variable.");
}
