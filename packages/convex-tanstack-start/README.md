# @samebase/convex-tanstack-start

Renders TanStack Start pages inside a Convex HTTP action, so the app needs no separate server host.
The package has a Vite plugin and a server entry. It owns no tables and needs no `app.use(...)`. The
hosting component in [samebase/convex-hosting](https://github.com/samebase/convex-hosting) serves
the browser files.

## Use

Add the plugin to `vite.config.ts`:

```ts
import { convexSsr } from "@samebase/convex-tanstack-start/vite";

export default defineConfig({
  plugins: [convexSsr(), tanstackStart({ prerender: { enabled: false } }), react()],
});
```

Create `src/server.ts`:

```ts
export { default } from "@samebase/convex-tanstack-start/server";
```

Build the app, then import `../dist/server/server.js` in `convex/http.ts`. Serve uploaded files with
`serveStaticAsset` first, and render every other path with the server entry's `fetch(request)`
inside the app's `httpAction`. The
[TanStack Start SSR example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
shows the complete route and declares the generated entry's type in `convex/server-build.d.ts`, so
typechecking also works before the first build.

For reactive queries, use the
[official Convex TanStack integration](https://docs.convex.dev/client/tanstack/tanstack-start/).
Components use `useSuspenseQuery(convexQuery(...))`; the server entry waits for their HTML, and
TanStack handles query hydration. HTTP mounts, authentication, and cache policy remain app
decisions.

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
resolution.
