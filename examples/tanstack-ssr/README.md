# TanStack Start SSR example

Renders TanStack Start pages inside a Convex HTTP action. The first HTML response already contains a
count from a Convex query, and after React hydrates, the count stays live.

## How it works

- `convex/http.ts` has one catch-all route. It serves uploaded files with `serveStaticAsset`, which
  looks up exact paths, and renders every other path with the TanStack Start server bundle.
- `src/router.tsx` sets up Convex's TanStack Query integration, so data from
  `useSuspenseQuery(convexQuery(...))` is in the first HTML and stays live.
- [`@samebase/convex-hosting-tanstack-start`](../../packages/convex-hosting-tanstack-start) makes
  TanStack Start run in the Convex runtime: `vite.config.ts` adds its `convexSsr()` plugin, and
  `src/server.ts` re-exports its server entry.

## Run

This example has its own schema, so use a separate Convex project. From the repository root:

```bash
pnpm install
cd examples/tanstack-ssr
pnpm run dev
```

The first run asks you to choose a Convex project. `pnpm run dev` then keeps the dev deployment in
sync: each change rebuilds the page bundles, pushes the backend, and uploads the browser files. Open
the `.convex.site` URL it prints. The page source contains the count and the render time. Open the
page in two tabs: a click in one updates both.

In development, backend pushes and file uploads are separate steps, so right after a change a page
can briefly refer to scripts that are not uploaded yet. Both bundles contain the deployment URL, so
rebuild before pushing to another deployment.

## Deploy

With `CONVEX_DEPLOY_KEY` set to a deploy key of the target deployment:

```bash
pnpm run deploy
```

This runs `convex-hosting deploy --dist ./dist/client --build-command "pnpm run build"`. The build
gets the deployment URL and a new version ID, which every rendered page carries in a
`<meta name="convex-hosting-version">` tag. `dist/client` uploads before the backend push, the new
version goes live after it, and `deploy` checks the tag on `/`. The first deploy to a deployment
pushes the backend first, so the site answers 404 until the upload ends.
