// The module that Vite emits from the app's src/server.ts, without declarations. Script file on
// purpose: a wildcard module name is only allowed in an ambient context, so tsc cannot emit it and
// the build copies it into dist.
declare module "*/dist/server/server.js" {
  const server: typeof import("./server.js").default;
  export default server;
}
