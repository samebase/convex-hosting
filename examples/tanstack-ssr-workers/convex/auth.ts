import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server";
import { components, internal } from "./_generated/api.js";

const core = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { signUpWithUsernamePassword, signInWithUsernamePassword } = setupUsernamePassword(
  core,
  { component: components.authPassword, usernameComponent: components.authUsername },
).attachUserCallbacks({ createUser: internal.users.createUser });
