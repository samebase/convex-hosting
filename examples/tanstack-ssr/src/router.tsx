import { createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { ConvexQueryClient } from "@convex-dev/react-query";
import { routeTree } from "./routeTree.gen.js";

export function getRouter() {
  // Start calls this for each server request, so clients are never shared. The private pages are
  // rendered on the server as the user, and `expectAuth` makes the browser client wait for the
  // provider's token before its first subscription, so the first live answer is the user's too.
  // Convex's Better Auth guide requires the same for a seamless SSR render.
  const convexQueryClient = new ConvexQueryClient(import.meta.env.VITE_CONVEX_URL, {
    expectAuth: true,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
      },
    },
  });
  convexQueryClient.connect(queryClient);
  const router = createRouter({
    routeTree,
    context: { queryClient, convexQueryClient },
    scrollRestoration: true,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

// The request context that convex/http.ts passes to the server entry: the access token of the
// session cookie, or null without a session.
declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { token: string | null } };
  }
}
