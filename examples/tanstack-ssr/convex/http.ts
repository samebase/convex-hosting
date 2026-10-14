import { httpRouter } from "convex/server";
import { httpCookies, ServerAuthSession, setupConvexAuthServer } from "@convex-dev/auth/server";
import { serveAsset } from "@samebase/convex-hosting";
import { api, components } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

// A local backend serves plain HTTP.
const cookieOptions = { secure: env.CONVEX_SITE_URL.startsWith("https:") };

// The browser signs in, refreshes, and signs out through these routes, and the refresh token stays
// in an httpOnly cookie. Exact routes win over the Convex Auth core component mounted at /auth/.
const auth = setupConvexAuthServer({
  convexUrl: env.CONVEX_CLOUD_URL,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  signIn: [api.auth.signInAnonymous],
  cookieOptions,
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

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const asset = await serveAsset(ctx, components.hosting, request, versionId);
    if (asset) return asset;

    const cookies = httpCookies(request);
    const session = new ServerAuthSession({
      refreshSession: (refreshToken) => ctx.runMutation(api.auth.refreshSession, { refreshToken }),
      cookies,
      cookieOptions,
    });
    const token = await session.getToken();

    // Every other path is a page. TanStack Start renders it, including its own 404 page. Loading
    // the renderer here keeps file requests fast.
    const { default: server } = await import("../dist/server/server.js");
    const page = await server.fetch(request, { context: { token } });
    // The deployment's Cloudflare front caches answers on static-looking paths, so a rendered 404
    // for a script requested before its upload ended would stay cached after the file exists.
    const headers = new Headers(page.headers);
    headers.set("Cache-Control", "no-store");
    cookies.applyTo(headers);
    return new Response(page.body, { status: page.status, headers });
  }),
});

export default http;
