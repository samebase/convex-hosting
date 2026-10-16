import { httpCookies, ServerAuthSession, setupConvexAuthServer } from "@convex-dev/auth/server";
import handler from "@tanstack/react-start/server-entry";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const convexUrl: string = import.meta.env.VITE_CONVEX_URL;
const convex = new ConvexHttpClient(convexUrl);

// A local backend serves plain HTTP.
const cookieOptions = { secure: convexUrl.startsWith("https:") };

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

// Runs when no file matches the path: on Convex, convex/http.ts calls it; in development, Vite's dev
// server does; on Cloudflare, it is the Worker. TanStack Start renders the page, including its own
// 404 page.
export default {
  async fetch(request: Request) {
    const route = request.method === "POST" && routes.get(new URL(request.url).pathname);
    if (route) return route(request);
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
