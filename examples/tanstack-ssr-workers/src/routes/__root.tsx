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
  SignedIn,
  SignedOut,
  sessionBeforeLoad,
  useSignOutSession,
} from "@samebase/convex-auth-tanstack-start";
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
      await context.queryClient.query(convexQuery(api.users.me, {}));
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
              {/* A document request: a navigation inside the app would run the loader in the browser. */}
              <Link to="/stream" reloadDocument>
                Stream
              </Link>
              <Link to="/server">Server</Link>
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
  // The server render knows the session from its token, so a rendered page carries the right
  // header; a prerendered page has no token and shows its header once the browser knows.
  return (
    <>
      <SignedOut>
        <Link to="/signin">Sign in</Link>
      </SignedOut>
      <SignedIn>
        <SignedInHeader />
      </SignedIn>
    </>
  );
}

function SignedInHeader() {
  // The root loader has queried the user for a page rendered as the user, so the name is in the
  // cache; `useQuery` does not fetch on the server, so a prerendered page shows it when the browser
  // has it.
  const { data: me } = useQuery(convexQuery(api.users.me, {}));
  const signOut = useSignOutSession("/auth/signout", "/");
  const [signOutFailed, setSignOutFailed] = useState(false);
  if (!me) return null;
  return (
    <div>
      {`Signed in as ${me.name}`}
      <button type="button" onClick={async () => setSignOutFailed(!(await signOut()))}>
        Sign out
      </button>
      {signOutFailed && "Sign-out failed. Try again."}
    </div>
  );
}
