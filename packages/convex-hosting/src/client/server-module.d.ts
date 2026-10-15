// Ambient declaration of the server entry that `convex-hosting init` writes as a placeholder and a
// framework adapter's Vite plugin replaces after each server build, so `convex/http.ts` typechecks
// with either. Script file on purpose: a wildcard module name is only allowed in an ambient context.
declare module "*/.convex-hosting/server.js" {
  const server: {
    fetch: (
      request: Request,
      opts?: { context?: Record<string, unknown> },
    ) => Response | Promise<Response>;
  };
  export default server;
}
