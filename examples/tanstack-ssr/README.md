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

The first run asks you to choose a Convex project. `pnpm run dev` builds the renderer once, because
`convex/http.ts` imports it, then runs `convex dev` with the Vite development server. Open the URL
that Vite prints. The page source contains the count and the render time. Open the page in two tabs:
a click in one updates both.

To check the hosted site on the development deployment while `pnpm run dev` runs:

```bash
pnpm run build && pnpm run upload
```

`convex dev` pushes the rebuilt renderer, and the upload makes the browser files live. Open
`https://<deployment>.convex.site`. Both bundles contain the deployment URL, so rebuild before you
push to another deployment.

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
