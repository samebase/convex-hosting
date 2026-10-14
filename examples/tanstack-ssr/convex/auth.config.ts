import type { AuthConfig } from "convex/server";
import { env } from "./_generated/server.js";

// The Convex Auth core signs each access token with AUTH_PRIVATE_KEY, the issuer CONVEX_SITE_URL,
// and the audience "convex". The core component serves the public key under its /auth mount.
export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "convex",
      issuer: env.CONVEX_SITE_URL,
      jwks: `${env.CONVEX_SITE_URL}/auth/.well-known/jwks.json`,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
