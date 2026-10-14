import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { convexQuery, type ConvexQueryClient } from "@convex-dev/react-query";
import { useAuthActions } from "@convex-dev/auth/nextjs";
import {
  SessionProvider,
  sessionBeforeLoad,
} from "@samebase/convex-hosting-tanstack-start/convex-auth";
import { api } from "../../convex/_generated/api.js";
import styleUrl from "../style.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
  beforeLoad: sessionBeforeLoad,
  loader: async ({ context }) => {
    // The token is undefined without a request context, as in the build's prerender of /about,
    // which must not query Convex.
    if (context.token !== undefined) {
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
  const { signOut } = useAuthActions();
  if (me === undefined) return null;
  if (me === null) return <Link to="/signin">Sign in</Link>;
  return (
    <>
      {`Signed in as ${me.name}`}
      <button
        type="button"
        onClick={async () => {
          await signOut();
          // `expectAuth` holds queries only before the first authentication, so a sign-out reloads
          // (Convex's Better Auth guide for TanStack Start says the same).
          location.reload();
        }}
      >
        Sign out
      </button>
    </>
  );
}
