import { httpRouter } from "convex/server";
import { setupConvexAuthServer } from "@convex-dev/auth/server";
import { serveSite } from "@samebase/convex-hosting";
import { api, components } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";
import worker from "../dist/server/convex.js";

const http = httpRouter();

// The browser signs in, refreshes, and signs out through these routes, and the refresh token stays
// in an httpOnly cookie. Exact routes win over the Convex Auth core component mounted at /auth/.
const auth = setupConvexAuthServer({
  convexUrl: env.CONVEX_CLOUD_URL,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  signIn: [api.auth.signInAnonymous],
  // A local backend serves plain HTTP.
  cookieOptions: { secure: env.CONVEX_SITE_URL.startsWith("https:") },
});
for (const [path, handler] of [
  ["/auth/signin", auth.convexProxyHandler],
  ["/auth/refresh", auth.refreshHandler],
  ["/auth/signout", auth.signOutHandler],
] as const) {
  http.route({
    path,
    method: "POST",
    handler: httpAction((_ctx, request) => handler(request)),
  });
}

// vinext renders pages, Server Actions, and route handlers, after proxy.ts refreshes the session.
async function render(request: Request) {
  // Work that vinext hands to `waitUntil` must end before the action does. Its `after()` callbacks
  // start only once the body has been read, so the body is read first.
  const pending: Promise<unknown>[] = [];
  const page = await worker.fetch(request, {}, { waitUntil: (promise) => pending.push(promise) });
  const body = await page.arrayBuffer();
  await Promise.allSettled(pending);
  const response = new Response(body, page);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

http.route({
  pathPrefix: "/",
  method: "GET",
  // A path without a file is a page.
  handler: httpAction((ctx, request) =>
    serveSite(ctx, components.hosting, request, versionId, () => render(request)),
  ),
});

// Server Actions post to the page's path. No file answers a POST.
http.route({
  pathPrefix: "/",
  method: "POST",
  handler: httpAction((_ctx, request) => render(request)),
});

export default http;
