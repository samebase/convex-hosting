import {
  httpActionGeneric,
  type GenericActionCtx,
  type GenericDataModel,
  type HttpRouter,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { notFound, serveRequest } from "../component/serving.js";

/**
 * Serve the live version from the app's HTTP router: a GET route for `pathPrefix` (default `/`).
 * Exact app routes and longer prefixes stay ahead of it in Convex's router. With a prefix, upload
 * with the same base path.
 *
 * The version config decides the behavior: `html_handling`, `not_found_handling`, `_headers`, and
 * `_redirects`. A request that the live version does not handle gets a 404 with `no-store`.
 *
 * @example
 * ```typescript
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
  { pathPrefix = "/" }: { pathPrefix?: string } = {},
) {
  if (!pathPrefix.startsWith("/")) {
    throw new Error("pathPrefix must start with /");
  }
  const handler = httpActionGeneric(
    async (ctx, request) =>
      (await serveRequest(ctx, component.lib.route, request, false, fetchBody)) ?? notFound(),
  );
  const prefix = pathPrefix.replace(/\/$/, "");
  http.route({ pathPrefix: `${prefix}/`, method: "GET", handler });
  if (prefix !== "") {
    http.route({ path: prefix, method: "GET", handler });
  }
}

/**
 * Serve an uploaded file from your own HTTP action, or return null when the live version does not
 * handle the request, so the action can continue with its own routing: server rendering, APIs,
 * redirects.
 *
 * The lookup is exact by default (`html_handling` and `not_found_handling` are "none"), so `/`
 * reaches your action and no `index.html` is needed. Pass `exact: false` to use the modes of the
 * version config.
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
  ctx: Pick<GenericActionCtx<GenericDataModel>, "runQuery">,
  component: ComponentApi,
  request: Request,
  { exact = true }: { exact?: boolean } = {},
): Promise<Response | null> {
  return await serveRequest(ctx, component.lib.route, request, exact, fetchBody);
}

/** The component's storage is not the app's, so an app's action reads a file by its URL. */
async function fetchBody({ storageUrl }: { storageUrl: string }) {
  const response = await fetch(storageUrl);
  return response.ok ? response.body : null;
}
