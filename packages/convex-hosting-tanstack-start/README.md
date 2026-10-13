# @samebase/convex-hosting-tanstack-start

Renders TanStack Start pages inside a Convex HTTP action, so the app needs no separate server host.
The package has a Vite plugin and a server entry. It owns no tables and needs no `app.use(...)`. The
hosting component in [samebase/convex-hosting](https://github.com/samebase/convex-hosting)
(`@samebase/convex-hosting` 0.4) serves the browser files.

## Use

Add the plugin to `vite.config.ts`:

```ts
import { convexSsr } from "@samebase/convex-hosting-tanstack-start/vite";

export default defineConfig({
  plugins: [convexSsr(), tanstackStart({ prerender: { enabled: false } }), react()],
});
```

Create `src/server.ts`:

```ts
export { default } from "@samebase/convex-hosting-tanstack-start/server";
```

Install the hosting component without `httpPrefix` (`app.use(hosting)`), build the app, and import
`../dist/server/server.js` in `convex/http.ts`:

```ts
http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const file = await serveStaticAsset(ctx, components.hosting, request);
    if (file) return file;
    const { default: server } = await import("../dist/server/server.js");
    return await server.fetch(request);
  }),
});
```

`serveStaticAsset` looks up the exact request path in the live version. It does not map `/` to
`/index.html` and has no SPA fallback, so the build needs no `index.html`: `/` and every other page
path return `null` and reach the renderer. A missing script also reaches it and gets TanStack's 404
page.

`server.fetch(request, opts)` is TanStack's request handler. `opts` has the type `RequestOptions`
from `@tanstack/react-start/server`, so an app passes its registered request context as
`{ context }`.

The
[TanStack Start SSR example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
shows the complete route and declares the generated entry's type in `convex/server-build.d.ts`, so
typechecking also works before the first build.

For reactive queries, use the
[official Convex TanStack integration](https://docs.convex.dev/client/tanstack/tanstack-start/).
Components use `useSuspenseQuery(convexQuery(...))`; the server entry waits for their HTML, and
TanStack handles query hydration. HTTP mounts, authentication, and cache policy remain app
decisions.

## Deploy

Release the backend and the browser files with one command:

```bash
npx @samebase/convex-hosting deploy --dist dist/client --build-command "npm run build"
```

1. `deploy` makes a version ID and gives it to the build as `CONVEX_HOSTING_VERSION_ID`.
2. In `npx convex deploy --cmd`, the build runs, and then `dist/client` uploads as the new version,
   not live yet. Then the push replaces the functions and the renderer.
3. `deploy` makes the new version live and fetches `/` (or `--verify-path`): the page must carry
   `<meta name="convex-hosting-version" content="<id>">` with the new ID.

On a first install, and on an upgrade from 0.3.x, the push runs first and the upload follows; the
site answers 404 until the upload ends. Hashed files under `/assets/` stay reachable from the
previous versions, so a page that was open before the release still loads its lazy scripts.

`convexSsr()` defines `import.meta.env.CONVEX_HOSTING_VERSION_ID` from the build environment, empty
when it is not set. When it is not empty, the server entry adds the meta tag before the first
`</head>` of every rendered page. `deploy --skip-build` reuses the ID from
`dist/client/.convex-hosting/version.json`, which the upload of the deploy that made the build
wrote.

## Why these settings exist

- `worker` selects TanStack's server exports; `browser` selects Web API adapters.
- `react-dom/server.edge` avoids the browser renderer's `MessageChannel` dependency.
- `ssr.noExternal` bundles dependencies instead of leaving runtime Node imports.
- React's Web Stream renderer waits for Suspense, then TanStack's `renderSsrHtmlResponse` handles
  the buffered HTML, hydration scripts, status, and cleanup. The default streaming handler imports
  Node stream modules that Convex cannot bundle.
- React emits a doctype and TanStack's HTML helper adds its own, so the server entry removes
  React's.
- The server entry supplies the missing `URLSearchParams.size` getter on Convex. TanStack needs it
  to normalize URLs with query parameters. Native implementations are left intact.

These settings apply to builds. Development and Node-based tests keep their normal dependency
resolution, and their pages have no version tag.
