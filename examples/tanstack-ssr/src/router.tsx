import { createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { ConvexQueryClient } from "@convex-dev/react-query";
import { routeTree } from "./routeTree.gen.js";

export function getRouter() {
  // Start calls this for each server request, so clients are never shared. `expectAuth` makes the
  // browser client wait for the provider's token before its first subscription, so a page rendered
  // as the user gets the user's live answer too; Convex's Better Auth guide requires the same.
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

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { token: string | null } };
  }
}
