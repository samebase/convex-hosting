import { httpCookies, ServerAuthSession, setupConvexAuthServer } from "@convex-dev/auth/server";
import handler from "@tanstack/react-start/server-entry";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const convexUrl: string = import.meta.env.VITE_CONVEX_URL;
const convex = new ConvexHttpClient(convexUrl);

// Answers every request that no file answers: on Convex, convex/http.ts calls it; in development,
// Vite's dev server does; on Cloudflare, it is the Worker. TanStack Start renders the page, including
// its own 404 page.
const server = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    // `Secure` when the browser reached the site over HTTPS. A local backend, Vite's dev server, and
    // wrangler dev serve plain HTTP, so the request decides, not the build or the backend URL.
    const cookieOptions = { secure: url.protocol === "https:" };
    if (request.method === "POST") {
      // The browser signs in, refreshes, and signs out through these routes, and the refresh token
      // stays in an httpOnly cookie on this origin.
      const auth = setupConvexAuthServer({
        convexUrl,
        refreshSession: api.auth.refreshSession,
        signOut: api.auth.signOut,
        signIn: [api.auth.signInAnonymous],
        cookieOptions,
      });
      switch (url.pathname) {
        case "/auth/signin":
          return auth.convexProxyHandler(request);
        case "/auth/refresh":
          return auth.refreshHandler(request);
        case "/auth/signout":
          return auth.signOutHandler(request);
      }
    }
    const cookies = httpCookies(request);
    const session = new ServerAuthSession({
      refreshSession: (refreshToken) => convex.mutation(api.auth.refreshSession, { refreshToken }),
      cookies,
      cookieOptions,
    });
    // The build's prerender renders without a visitor, so its page, which every visitor gets, must
    // not say signed out: vite.config.ts marks its requests, and they get no token at all.
    const token = request.headers.has("x-prerender") ? undefined : await session.getToken();
    const page = await handler.fetch(request, { context: { token } });
    const headers = new Headers(page.headers);
    cookies.applyTo(headers);
    // Session-bearing HTML must never be reused by a cache. On Convex, `serveSite` sets it too.
    headers.set("Cache-Control", "no-store");
    return new Response(page.body, { status: page.status, headers });
  },
};

export default server;
