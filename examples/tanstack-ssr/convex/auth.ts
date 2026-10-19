import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupAnonymous } from "@convex-dev/auth/methods/anonymous/server";
import { components, internal } from "./_generated/api.js";

const core = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession } = core;

export const { signInAnonymously } = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks({ createUser: internal.users.createUserAnonymous });
