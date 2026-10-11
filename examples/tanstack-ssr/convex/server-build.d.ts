// Vite emits this module from src/server.ts without TypeScript declarations.
declare module "*/dist/server/server.js" {
  const server: typeof import("@samebase/convex-tanstack-start/server").default;
  export default server;
}
