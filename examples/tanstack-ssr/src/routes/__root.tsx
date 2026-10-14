import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import { ConvexAuthNextjsProvider, useConvexAuth } from "@convex-dev/auth/nextjs";
import type { ConvexReactClient } from "convex/react";
import { useEffect } from "react";
import styleUrl from "../style.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
  beforeLoad: ({ context, serverContext }) => {
    // Only the server render has a request, and with it the token of the session cookie. Its
    // loaders query Convex with that token. The browser restores this return value when it
    // hydrates; a later navigation in the browser rebuilds the context without it, so `token` is
    // undefined there.
    const token = serverContext?.token;
    if (token) context.convexQueryClient.serverHttpClient?.setAuth(token);
    return { token };
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
  // The provider reads `initialToken` once, when it mounts, so the browser client starts with the
  // token that the server rendered with. Sign-in, refresh, and sign-out go to the /auth routes of
  // convex/http.ts.
  return (
    <ConvexAuthNextjsProvider client={convexQueryClient.convexClient} initialToken={token}>
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <ReleaseWhenSignedOut client={convexQueryClient.convexClient} />
          <Outlet />
          <Scripts />
        </body>
      </html>
    </ConvexAuthNextjsProvider>
  );
}

// The browser's Convex client has `expectAuth`, so it holds its queries until it has a token.
// Without it, the client subscribes to the queries of the server render when its WebSocket opens,
// before the auth provider sets the token: /me showed "Not signed in" for a moment, and React
// reported a hydration mismatch when that answer arrived during hydration. The provider sets no
// token for a signed-out visitor, so once it knows there is no session, this lets the client run
// without one.
function ReleaseWhenSignedOut({ client }: { client: ConvexReactClient }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  useEffect(() => {
    if (!isLoading && !isAuthenticated)
      client.setAuth(
        async () => null,
        () => {},
      );
  }, [client, isLoading, isAuthenticated]);
  return null;
}
