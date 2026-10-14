"use client";

import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import { api } from "../../convex/_generated/api.js";

export default function SignIn() {
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
  return (
    <main>
      <h1>Sign in</h1>
      <button
        type="button"
        onClick={async () => {
          await signInAnonymous();
          // A document load: the server renders /todos as the user from the new cookie.
          location.assign("/todos");
        }}
      >
        Sign in anonymously
      </button>
    </main>
  );
}
