import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
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
          <Outlet />
          <Scripts />
        </body>
      </html>
    </ConvexAuthNextjsProvider>
  );
}
