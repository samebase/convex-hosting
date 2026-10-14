import {
  ClientOnly,
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import { ConvexProvider } from "convex/react";
import styleUrl from "../style.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "TanStack Start SPA on Convex" },
    ],
    links: [{ rel: "stylesheet", href: styleUrl }],
  }),
  component: Root,
});

function Root() {
  const { queryClient, convexQueryClient } = Route.useRouteContext();
  return (
    <ConvexProvider client={convexQueryClient.convexClient}>
      <QueryClientProvider client={queryClient}>
        <html lang="en">
          <head>
            <HeadContent />
          </head>
          <body>
            {/* The shell answers every path. The route and the active link depend on the path, so
            they render after hydration instead of failing it (TanStack/router#7910). */}
            <ClientOnly>
              <header>
                <Link to="/">Home</Link>
                <Link to="/about">About</Link>
              </header>
              <Outlet />
            </ClientOnly>
            <Scripts />
          </body>
        </html>
      </QueryClientProvider>
    </ConvexProvider>
  );
}
