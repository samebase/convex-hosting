import { createFileRoute } from "@tanstack/react-router";
import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import { api } from "../../convex/_generated/api.js";

export const Route = createFileRoute("/signin")({
  component: SignIn,
});

function SignIn() {
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
  return (
    <main>
      <h1>Sign in</h1>
      <button
        type="button"
        onClick={async () => {
          await signInAnonymous();
          // A document load, like sign-out: the server renders /todos as the user from the new
          // cookie. The provider confirms the session after this resolves, so a navigation inside
          // the app could reach the gate first and bounce back here.
          location.assign("/todos");
        }}
      >
        Sign in anonymously
      </button>
    </main>
  );
}
