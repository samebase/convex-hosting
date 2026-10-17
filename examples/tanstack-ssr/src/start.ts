import { createMiddleware, createStart } from "@tanstack/react-start";

// Runs for every request Start handles: pages, server functions, server routes. Session-bearing
// answers must never be reused by a cache, and on Convex the *.convex.site front caches paths with
// an extension unless told not to.
const noStore = createMiddleware({ type: "request" }).server(async ({ next }) => {
  const result = await next();
  result.response.headers.set("Cache-Control", "no-store");
  return result;
});

export const startInstance = createStart(() => ({ requestMiddleware: [noStore] }));
