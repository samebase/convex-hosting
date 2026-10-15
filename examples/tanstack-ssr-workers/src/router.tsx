import { createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { ConvexQueryClient } from "@convex-dev/react-query";
import { routeTree } from "./routeTree.gen.js";

export function getRouter() {
  // Start calls this for each server request, so clients are never shared.
  const convexQueryClient = new ConvexQueryClient(import.meta.env.VITE_CONVEX_URL, {
    // Holds queries until the session is known; `SessionProvider` explains it.
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
