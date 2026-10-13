# TanStack Start SSR example

Renders TanStack Start pages inside a Convex HTTP action. The first HTML response already contains a
count from a Convex query, and after React hydrates, the count stays live.

- `convex/http.ts` serves the browser files with `serveAsset` and renders every other path with the
  TanStack Start server bundle.
- `src/router.tsx` sets up Convex's TanStack Query integration, so data from
  `useSuspenseQuery(convexQuery(...))` is in the first HTML and stays live.
- [`@samebase/convex-hosting-tanstack-start`](../../packages/convex-hosting-tanstack-start) makes
  TanStack Start run in the Convex runtime: `vite.config.ts` adds its `convexSsr()` plugin, and
  `src/server.ts` re-exports its server entry.

## Development deployment

This example has its own schema, so use a separate Convex project. From `examples/tanstack-ssr`,
with `npx convex dev` running in another terminal:

```bash
pnpm run build
pnpm run upload
```

`convex/http.ts` imports `dist/server`, so `npx convex dev` pushes after each build, before the
upload writes the new version: until the upload ends, the new pages refer to files that answer 404.

## Production

```bash
pnpm run deploy
```
