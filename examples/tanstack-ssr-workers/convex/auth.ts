import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupAnonymous } from "@convex-dev/auth/methods/anonymous/server";
import { setupGithub } from "@convex-dev/auth/methods/github/server";
import { components, internal } from "./_generated/api.js";

const core = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession } = core;

export const { signInAnonymously } = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks({ createUser: internal.users.createUserAnonymous });

// A flow returns to the page where it started, on the Worker's site.
export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(core, {
  component: components.authGithub,
  allowedRedirectOrigins: ["https://convex-hosting-tanstack-ssr-workers.pfp.workers.dev"],
}).attachUserCallbacks({ createUser: internal.users.createUserGithub });
