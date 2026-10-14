# @samebase/convex-hosting-tanstack-start

Renders TanStack Start pages inside a Convex HTTP action, so the app needs no separate server host.
The package has a Vite plugin, a server entry with its type, and helpers for Convex Auth cookie
sessions. It owns no tables and needs no `app.use(...)`. The hosting component in
[samebase/convex-hosting](https://github.com/samebase/convex-hosting) serves the browser files.

## Use

Add the plugin to `vite.config.ts`:

```ts
import { convexSsr } from "@samebase/convex-hosting-tanstack-start/vite";

export default defineConfig({
  plugins: [convexSsr(), tanstackStart(), react()],
});
```

Create `src/server.ts`, which Vite builds as the server entry:

```ts
export { default } from "@samebase/convex-hosting-tanstack-start/server";
```

Vite emits the server entry without TypeScript declarations, so the package ships its type. Add it
to `convex/tsconfig.json`, and to any other `tsconfig.json` whose files import
`convex/_generated/api`, which reaches `convex/http.ts`:

```json
{
  "compilerOptions": {
    "types": ["@samebase/convex-hosting-tanstack-start/server-build"]
  }
}
```

In `convex/http.ts`, `serveSite` serves the uploaded files and renders every other path with the
server entry of the build:

```ts
http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction((ctx, request) =>
    serveSite(ctx, components.hosting, request, versionId, async () => {
      // Loading the renderer here keeps file requests fast.
      const { default: server } = await import("../dist/server/server.js");
      return server.fetch(request);
    }),
  ),
});
```

For reactive queries, use the
[official Convex TanStack integration](https://docs.convex.dev/client/tanstack/tanstack-start/).
Components use `useSuspenseQuery(convexQuery(...))`; the server entry waits for their HTML, and
TanStack handles query hydration.

To give the pages data of the request, pass it as `context`: `server.fetch(request, { context })`.
Start gives it to each route's `beforeLoad` and loader on the server as `serverContext`, typed as
`requestContext` in Start's `Register`.

## Convex Auth sessions

With [Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies,
`convex/http.ts` reads the session in `render` and passes its access token as
`server.fetch(request, { context: { token } })`, as the
[TanStack Start SSR example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
does. `@samebase/convex-hosting-tanstack-start/convex-auth` has the rest, and importing it declares
`requestContext` as `{ token: string | null }`. The app creates its Convex client with
`expectAuth: true`.

The root route gives the token to the server render's Convex client and wraps the document in the
session provider:

```tsx
import {
  SessionProvider,
  sessionBeforeLoad,
} from "@samebase/convex-hosting-tanstack-start/convex-auth";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
  beforeLoad: sessionBeforeLoad,
  component: Root,
});

function Root() {
  const { convexQueryClient, token } = Route.useRouteContext();
  return (
    <SessionProvider client={convexQueryClient.convexClient} token={token}>
      <html lang="en">{/* ... */}</html>
    </SessionProvider>
  );
}
```

A pathless layout route gates the pages under it:

```tsx
import {
  RedirectWithoutSession,
  redirectWithoutSession,
} from "@samebase/convex-hosting-tanstack-start/convex-auth";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ serverContext }) => redirectWithoutSession(serverContext, "/signin"),
  component: () => (
    <RedirectWithoutSession to="/signin">
      <Outlet />
    </RedirectWithoutSession>
  ),
});
```

- `sessionBeforeLoad`: on the server, the render's Convex HTTP client queries with the token, so
  loaders run as the user. It puts `token` in the route context.
- `SessionProvider`: Convex Auth's provider, started from the token of the server render. It also
  releases `expectAuth` for a visitor without a session, which Convex's provider never does.
- `redirectWithoutSession`: a server render without a session redirects. Only the server render has
  the cookie; a browser navigation has no `serverContext`.
- `RedirectWithoutSession`: navigates when the session ends, in this tab or in another one.

`@convex-dev/auth` is an optional peer dependency: an app with another auth provider uses only the
plugin and the server entry.

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
