import { httpRouter } from "convex/server";
import { httpCookies, ServerAuthSession, setupConvexAuthServer } from "@convex-dev/auth/server";
import { serveAsset } from "@samebase/convex-hosting";
import { api, components } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

// Cookie sessions: the refresh token stays in an httpOnly cookie on the site origin, and the
// browser holds only the short-lived access token. These are the default routes of the auth
// provider in src/routes/__root.tsx. Exact routes win over the Convex Auth core component, which
// is mounted at /auth/ (convex.config.ts) and serves its key set there.
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
      cookieOptions: { secure: env.CONVEX_SITE_URL.startsWith("https:") },
    });
    const token = await session.getToken();

    // Every other path is a page. TanStack Start renders it, including its own 404 page. Loading
    // the renderer here keeps file requests fast.
    const { default: server } = await import("../dist/server/server.js");
    const page = await server.fetch(request, { context: { token } });
    // The deployment's Cloudflare front caches answers on static-looking paths, so a rendered 404
    // for a script requested before its upload ended would stay cached after the file exists (the
    // 0.3.2 incident).
    const headers = new Headers(page.headers);
    headers.set("Cache-Control", "no-store");
    // The page carries the `Set-Cookie` headers of a session refresh, which rotates both cookies.
    cookies.applyTo(headers);
    return new Response(page.body, { status: page.status, headers });
  }),
});

export default http;
