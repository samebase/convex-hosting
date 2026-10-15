import { setupConvexAuthNextjs } from "@convex-dev/auth/nextjs/server";
import { api } from "./convex/_generated/api.js";

export const convexUrl: string = import.meta.env.VITE_CONVEX_URL;

export const {
  convexAuthNextjsProxy,
  convexAuthNextjsAccessToken,
  isAuthenticatedNextjs,
  ConvexAuthNextjsServerProvider,
} = setupConvexAuthNextjs({
  convexUrl,
  refreshSession: api.auth.refreshSession,
  isAuthenticated: api.auth.isAuthenticated,
  // A local backend serves plain HTTP, as in the /auth routes of convex/http.ts.
  cookieOptions: { secure: convexUrl.startsWith("https:") },
});
