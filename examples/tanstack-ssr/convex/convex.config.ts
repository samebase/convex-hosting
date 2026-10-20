import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config";
import anonymous from "@convex-dev/auth/components/anonymous/convex.config";
import github from "@convex-dev/auth/components/github/convex.config";
import hosting from "@samebase/convex-hosting/convex.config";

// A push fails while any of these variables is missing on the deployment. The GitHub component's
// own variables are required, and Convex refuses to bind them to optional ones.
const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
    AUTH_GITHUB_CLIENT_ID: v.string(),
    AUTH_GITHUB_CLIENT_SECRET: v.string(),
  },
});
app.use(auth, {
  httpPrefix: "/auth",
  env: { AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY, AUTH_JWKS: app.env.AUTH_JWKS },
});
app.use(anonymous);
// GitHub's callback, the GitHub OAuth app's callback URL: <CONVEX_SITE_URL>/auth/github/callback.
app.use(github, {
  httpPrefix: "/auth/github",
  env: {
    CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
  },
});
app.use(hosting);
export default app;
