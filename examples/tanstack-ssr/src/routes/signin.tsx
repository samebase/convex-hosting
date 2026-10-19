import { createFileRoute } from "@tanstack/react-router";
import { useSignInAnonymously } from "@convex-dev/auth/methods/anonymous/react";
import { api } from "../../convex/_generated/api.js";

export const Route = createFileRoute("/signin")({
  component: SignIn,
});

function SignIn() {
  const { signIn } = useSignInAnonymously(api.auth);
  return (
    <main>
      <h1>Sign in</h1>
      <button
        type="button"
        onClick={async () => {
          await signIn();
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
