import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { convexQuery, type ConvexQueryClient } from "@convex-dev/react-query";
import {
  SessionProvider,
  sessionBeforeLoad,
  useSignOutSession,
} from "@samebase/convex-hosting-tanstack-start/convex-auth";
import { useState } from "react";
import { api } from "../../convex/_generated/api.js";
import styleUrl from "../style.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
  beforeLoad: sessionBeforeLoad,
  loader: async ({ context }) => {
    // A visitor without a session has no user. The build's prerender of /about has none either,
    // and must not query Convex.
    if (context.token) {
      await context.queryClient.ensureQueryData(convexQuery(api.users.me, {}));
    }
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "TanStack Start on Convex" },
    ],
    links: [{ rel: "stylesheet", href: styleUrl }],
  }),
  component: Root,
});

function Root() {
  const { convexQueryClient, token } = Route.useRouteContext();
  return (
    <SessionProvider client={convexQueryClient.convexClient} token={token}>
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <header>
            <nav>
              <Link to="/">Home</Link>
              <Link to="/about">About</Link>
              <Link to="/todos">Todos</Link>
            </nav>
            <SessionHeader />
          </header>
          <Outlet />
          <Scripts />
        </body>
      </html>
    </SessionProvider>
  );
}

function SessionHeader() {
  // `useQuery` does not fetch on the server, so the header of a prerendered page stays empty until
  // the browser has the answer.
  const { data: me } = useQuery(convexQuery(api.users.me, {}));
  const signOut = useSignOutSession("/auth/signout");
  const [signOutFailed, setSignOutFailed] = useState(false);
  if (me === undefined) return null;
  if (me === null) return <Link to="/signin">Sign in</Link>;
  return (
    <>
      {`Signed in as ${me.name}`}
      <button type="button" onClick={async () => setSignOutFailed(!(await signOut()))}>
        Sign out
      </button>
      {signOutFailed && "Sign-out failed. Try again."}
    </>
  );
}
