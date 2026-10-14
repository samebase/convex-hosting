import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api.js";

export const Route = createFileRoute("/_authed/me")({
  // On the server, the query runs with the token of the session cookie.
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(convexQuery(api.users.me, {}));
  },
  component: Me,
});

function Me() {
  const { data: me } = useSuspenseQuery(convexQuery(api.users.me, {}));
  const { signOut } = useAuthActions();
  if (me === null) return null;
  return (
    <main>
      <h1>Your session</h1>
      <p>{`Signed in as ${me.id} since ${new Date(me.since).toISOString()}`}</p>
      <button
        type="button"
        onClick={async () => {
          await signOut();
          // Convex's `expectAuth` holds queries only before the first authentication, so after a
          // sign-out the page reloads, as Convex's Better Auth guide for TanStack Start recommends.
          location.reload();
        }}
      >
        Sign out
      </button>
      <p>
        <Link to="/">Back to the counter</Link>
      </p>
    </main>
  );
}
