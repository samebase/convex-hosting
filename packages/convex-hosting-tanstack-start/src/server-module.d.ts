// Ambient declarations of the server build that `convex/http.ts` imports: the app's `src/server.ts`
// as Vite built it, whose default export answers a request like a Cloudflare Worker. A Vite
// TanStack Start build writes it to `<build.outDir or dist>/server/<entry basename>.js`, or `.mjs`
// when the app's `package.json` has no `"type": "module"`. These cover the default output only:
// `dist/server/server.js` and `dist/server/server.mjs`. An app that changes the output folder or
// the entry name declares its own path with one wildcard line. Script file on purpose: a wildcard
// module name is only allowed in an ambient context. The build copies it into `dist`.
declare module "*/dist/server/server.js" {
  const server: { fetch(request: Request): Promise<Response> };
  export default server;
}

declare module "*/dist/server/server.mjs" {
  const server: { fetch(request: Request): Promise<Response> };
  export default server;
}
