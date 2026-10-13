# TanStack Start SSR example

TanStack Start pages rendered inside a Convex HTTP action. The first HTML response already contains
a count from a Convex query, and the count stays live after React hydrates. `convex/http.ts` serves
the browser files with `serveAsset` and renders every other path with the server build, through
[`@samebase/convex-hosting-tanstack-start`](../../packages/convex-hosting-tanstack-start). The
example has its own schema, so it needs its own Convex project.

From `examples/tanstack-ssr`:

- `pnpm run build`: build the browser files into `dist/client` and the server into `dist/server`.
- `pnpm run upload`: upload `dist/client` to the development deployment that `npx convex dev`
  pushes.
- `pnpm run deploy`: build, upload, and push to production.

For the order of the first start and everything else, see the [README](../../README.md).
