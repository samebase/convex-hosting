# @samebase/convex-hosting-tanstack-start

Renders TanStack Start pages inside a Convex HTTP action, so the app needs no separate server host.
The package has a Vite plugin and a server entry. It owns no tables and needs no `app.use(...)`. The
hosting component in [samebase/convex-hosting](https://github.com/samebase/convex-hosting) serves
the browser files.

## Use

Add the plugin to `vite.config.ts`:

```ts
import { convexSsr } from "@samebase/convex-hosting-tanstack-start/vite";

export default defineConfig({
  plugins: [convexSsr(), tanstackStart(), react()],
});
```

Create `src/server.ts`:

```ts
export { default } from "@samebase/convex-hosting-tanstack-start/server";
```

In `convex/http.ts`, serve the uploaded files with `serveAsset` first, then render every other path
with the server entry of the build:

```ts
import { httpRouter } from "convex/server";
import { serveAsset } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const asset = await serveAsset(ctx, components.hosting, request, versionId);
    if (asset) return asset;
    const { default: server } = await import("../dist/server/server.js");
    const page = await server.fetch(request);
    // The deployment's Cloudflare front caches answers on static-looking paths, so a rendered 404
    // for a script requested before its upload ended would stay cached after the file exists.
    const headers = new Headers(page.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(page.body, { status: page.status, headers });
  }),
});

export default http;
```

The
[TanStack Start SSR example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
declares the server entry's type in `convex/server-build.d.ts`, so typechecking also works before
the first build.

For reactive queries, use the
[official Convex TanStack integration](https://docs.convex.dev/client/tanstack/tanstack-start/).
Components use `useSuspenseQuery(convexQuery(...))`; the server entry waits for their HTML, and
TanStack handles query hydration.

To give the pages data of the request, such as the access token of a session cookie, pass it as
`context`: `server.fetch(request, { context: { token } })`. Start gives it to each route's
`beforeLoad` and loader on the server as `serverContext`. Declare its type in Start's `Register`:

```ts
declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { token: string | null } };
  }
}
```

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
