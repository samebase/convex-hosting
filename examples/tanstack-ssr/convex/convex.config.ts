import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/core/convex.config.js";
import anonymous from "@convex-dev/auth/providers/anonymous/convex.config.js";
import hosting from "@samebase/convex-hosting/convex.config";

// A push fails while a declared variable is missing. The README says how to set both on a
// deployment.
const app = defineApp({
  env: { AUTH_PRIVATE_KEY: v.string(), AUTH_JWKS: v.string() },
});
app.use(auth, {
  httpPrefix: "/auth",
  env: { AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY, AUTH_JWKS: app.env.AUTH_JWKS },
});
app.use(anonymous);
app.use(hosting);
export default app;
