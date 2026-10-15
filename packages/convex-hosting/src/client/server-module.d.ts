// Ambient declaration of the server build that a server-rendered app's `convex/http.ts` imports,
// such as TanStack Start's `dist/server/server.js`, so `convex/http.ts` typechecks before the first
// build. Script file on purpose: a wildcard module name is only allowed in an ambient context.
declare module "*/dist/server/server.js" {
  const server: {
    fetch: (
      request: Request,
      opts?: { context?: Record<string, unknown> },
    ) => Response | Promise<Response>;
  };
  export default server;
}
