import type { AuthConfig } from "convex/server";
import { convexAuthProvider } from "@convex-dev/auth/server";

// The deployment signs the tokens with its own key, so the app keeps no key pair.
export default {
  providers: [convexAuthProvider()],
} satisfies AuthConfig;
