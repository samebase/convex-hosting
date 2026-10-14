// The module that scripts/bundle-server.ts writes from vinext's Worker entry, without declarations.
// Script file on purpose: a wildcard module name is only allowed in an ambient context.
declare module "*/dist/server/convex.js" {
  const worker: {
    fetch: (
      request: Request,
      env: Record<string, never>,
      ctx: { waitUntil: (promise: Promise<unknown>) => void },
    ) => Promise<Response>;
  };
  export default worker;
}
