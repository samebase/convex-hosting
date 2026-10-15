// Ambient declarations of the server build that `convex/http.ts` imports, typed as this package's
// server entry. A Vite TanStack Start build writes it to `<build.outDir or dist>/server/<entry
// basename>.js`, or `.mjs` when the app's `package.json` has no `"type": "module"`. These cover the
// default output only: `dist/server/server.js` and `dist/server/server.mjs`. An app that changes the
// output folder or the entry name declares its own path with one wildcard line. Script file on
// purpose: a wildcard module name is only allowed in an ambient context. The build copies it into
// `dist`, next to `server.d.ts`, which `./server.js` names there.
declare module "*/dist/server/server.js" {
  const server: typeof import("./server.js").default;
  export default server;
}

declare module "*/dist/server/server.mjs" {
  const server: typeof import("./server.js").default;
  export default server;
}
