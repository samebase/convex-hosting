import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import { api } from "../../convex/_generated/api.js";

export const Route = createFileRoute("/me")({
  // On the server, the query runs with the token of the session cookie.
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(convexQuery(api.users.me, {}));
  },
  component: Me,
});

function Me() {
  const { data: me } = useSuspenseQuery(convexQuery(api.users.me, {}));
  const { signOut } = useAuthActions();
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
  return (
    <main>
      <h1>Your session</h1>
      {me ? (
        <>
          <p>{`Signed in as ${me.id} since ${new Date(me.since).toISOString()}`}</p>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </>
      ) : (
        <>
          <p>Not signed in</p>
          <button type="button" onClick={() => void signInAnonymous()}>
            Sign in anonymously
          </button>
        </>
      )}
      <p>
        <Link to="/">Back to the counter</Link>
      </p>
    </main>
  );
}
