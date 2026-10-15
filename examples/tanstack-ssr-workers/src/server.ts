import { httpCookies, ServerAuthSession, setupConvexAuthServer } from "@convex-dev/auth/server";
import handler from "@tanstack/react-start/server-entry";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const convexUrl: string = import.meta.env.VITE_CONVEX_URL;
const convex = new ConvexHttpClient(convexUrl);

// Secure in a production build, as Convex Auth's Next.js integration decides: Vite's dev server
// serves plain HTTP.
const cookieOptions = { secure: import.meta.env.PROD };

// The browser signs in, refreshes, and signs out through these routes, and the refresh token stays
// in an httpOnly cookie on this origin.
const auth = setupConvexAuthServer({
  convexUrl,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  signIn: [api.auth.signInAnonymous],
  cookieOptions,
});
const routes = new Map([
  ["/auth/signin", auth.convexProxyHandler],
  ["/auth/refresh", auth.refreshHandler],
  ["/auth/signout", auth.signOutHandler],
]);

// The Worker runs when no file matches the path. TanStack Start renders the page, including its own
// 404 page.
export default {
  async fetch(request: Request) {
    const route = request.method === "POST" && routes.get(new URL(request.url).pathname);
    if (route) return route(request);
    // The build's prerender of /about sends this header (vite.config.ts). It renders without a
    // session and sends no query, because in Workers Builds the build runs before Convex's push.
    // @ts-expect-error The registered request context is required, and the prerender has none.
    if (request.headers.has("x-prerender")) return handler.fetch(request);
    const cookies = httpCookies(request);
    const session = new ServerAuthSession({
      refreshSession: (refreshToken) => convex.mutation(api.auth.refreshSession, { refreshToken }),
      cookies,
      cookieOptions,
    });
    const token = await session.getToken();
    const page = await handler.fetch(request, { context: { token } });
    const headers = new Headers(page.headers);
    cookies.applyTo(headers);
    // Session-bearing HTML must never be reused by a cache, the rule `serveSite` applies on Convex.
    headers.set("Cache-Control", "no-store");
    return new Response(page.body, { status: page.status, headers });
  },
};
