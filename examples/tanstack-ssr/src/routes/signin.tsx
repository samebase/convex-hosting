import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import { api } from "../../convex/_generated/api.js";

export const Route = createFileRoute("/signin")({
  component: SignIn,
});

function SignIn() {
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
  const navigate = useNavigate();
  return (
    <main>
      <h1>Sign in</h1>
      <button
        type="button"
        onClick={async () => {
          await signInAnonymous();
          await navigate({ to: "/todos" });
        }}
      >
        Sign in anonymously
      </button>
    </main>
  );
}
