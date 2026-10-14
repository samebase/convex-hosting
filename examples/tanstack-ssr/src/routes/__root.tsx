import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { convexQuery, type ConvexQueryClient } from "@convex-dev/react-query";
import { ConvexAuthNextjsProvider, useAuthActions, useConvexAuth } from "@convex-dev/auth/nextjs";
import type { ConvexReactClient } from "convex/react";
import { useEffect } from "react";
import { api } from "../../convex/_generated/api.js";
import styleUrl from "../style.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
  beforeLoad: ({ context, serverContext }) => {
    // Only the server render has the cookie's token, and its loaders query Convex with it. The
    // browser gets this value at hydration and no token on later navigations.
    const token = serverContext?.token;
    if (token) context.convexQueryClient.serverHttpClient?.setAuth(token);
    return { token };
  },
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
  // The provider reads `initialToken` once, when it mounts, so the browser starts with the token
  // that the server rendered with.
  return (
    <ConvexAuthNextjsProvider client={convexQueryClient.convexClient} initialToken={token}>
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <ReleaseWhenSignedOut client={convexQueryClient.convexClient} />
          <header>
            <SessionHeader />
          </header>
          <Outlet />
          <Scripts />
        </body>
      </html>
    </ConvexAuthNextjsProvider>
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
      {`Signed in as ${me.id}`}
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

// `expectAuth` makes the browser client wait for a token before its first subscription, so a page
// rendered as the user gets the user's live answer, and it never releases for a visitor without a
// session. Convex's AuthKit template decides `expectAuth` on the server per request; TanStack
// creates the client before the page knows the session, so this releases it when the provider
// reports none.
function ReleaseWhenSignedOut({ client }: { client: ConvexReactClient }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  useEffect(() => {
    if (!isLoading && !isAuthenticated) client.setAuth(async () => null);
  }, [client, isLoading, isAuthenticated]);
  return null;
}
