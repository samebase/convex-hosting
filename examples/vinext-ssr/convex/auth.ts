import { setupCore } from "@convex-dev/auth/core/setup";
import { setupAnonymous } from "@convex-dev/auth/providers/anonymous/setup";
import { components, internal } from "./_generated/api.js";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { signInAnonymous } = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks({ createUser: internal.users.createUserAnonymous });
