// The HTTP side of serving, shared by the component's own route (http.ts) and the app-side entry
// points in src/client. The routing itself runs in the component's `route` query.

import type { FunctionReference, GenericActionCtx, GenericDataModel } from "convex/server";

type Header = { name: string; value: string };

/** What `route` returns for a body: the selected entry's object. */
type RoutedBody = { storageId: string; storageUrl: string; contentType: string };

/** `api.lib.route` in the component, or the component's `lib.route` in an app. */
type RouteQuery<Body extends RoutedBody> = FunctionReference<
  "query",
  "public" | "internal",
  { method: "GET" | "HEAD"; url: string; headers: Header[]; exact: boolean },
  { handled: false } | { handled: true; status: number; headers: Header[]; body: Body | null }
>;

/**
 * Route `request` through the component and build the response, or return null when the live
 * version does not handle it. `read` returns the body of the selected entry, or null when storage
 * does not have it.
 */
export async function serveRequest<Body extends RoutedBody>(
  ctx: Pick<GenericActionCtx<GenericDataModel>, "runQuery">,
  route: RouteQuery<Body>,
  request: Request,
  exact: boolean,
  read: (body: Body) => Promise<BodyInit | null>,
): Promise<Response | null> {
  const result = await ctx.runQuery(route, {
    // Convex routes HEAD requests through GET routes, so no other method arrives here.
    method: request.method === "HEAD" ? "HEAD" : "GET",
    url: request.url,
    headers: Array.from(request.headers, ([name, value]) => ({ name, value })),
    exact,
  });
  if (!result.handled) return null;
  const headers = new Headers(
    result.headers.map(({ name, value }): [string, string] => [name, value]),
  );
  if (result.body === null) return new Response(null, { status: result.status, headers });
  const body = await read(result.body);
  if (body === null) return textResponse(500, "Storage error");
  return new Response(body, { status: result.status, headers });
}

/** The response of a static route for a request that the live version does not handle. */
export function notFound() {
  return textResponse(404, "Not Found");
}

function textResponse(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  });
}

/**
 * If-None-Match uses weak comparison for GET and HEAD requests. Browsers and proxies may send a
 * weak validator, a comma-separated list of validators, or `*`.
 */
export function etagMatches(ifNoneMatch: string | null, currentEtag: string): boolean {
  if (!ifNoneMatch) return false;

  const normalize = (value: string) => value.trim().replace(/^W\//, "").trim();
  const normalizedCurrent = normalize(currentEtag);

  return ifNoneMatch.split(",").some((candidate) => {
    const normalizedCandidate = normalize(candidate);
    return normalizedCandidate === "*" || normalizedCandidate === normalizedCurrent;
  });
}
