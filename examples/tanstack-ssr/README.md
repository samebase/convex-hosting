# TanStack Start SSR example

TanStack Start pages rendered inside a Convex HTTP action. The first HTML response already contains
a count from a Convex query, and the count stays live after React hydrates. `convex/http.ts` serves
the browser files with `serveAsset` and renders every other path with the server build, through
[`@samebase/convex-hosting-tanstack-start`](../../packages/convex-hosting-tanstack-start). The
example has its own schema, so it needs its own Convex project.

From `examples/tanstack-ssr`:

- `pnpm run dev`: Vite's dev server, with `npx convex dev` in another terminal. It renders the pages
  in Vite's own server; the Convex HTTP action renders them only on the deployed site.
- `pnpm run build`: build the browser files into `dist/client` and the server into `dist/server`.
- `pnpm run deploy:dev`: build, upload, and push to the development deployment.
- `pnpm run deploy`: build, upload, and push to production.

For everything else, see the [README](../../README.md).
