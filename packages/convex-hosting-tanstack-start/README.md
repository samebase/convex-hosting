# @samebase/convex-hosting-tanstack-start

Renders TanStack Start pages inside a Convex HTTP action, so the app needs no separate server host.
The package has a Vite plugin, a server entry, and helpers for Convex Auth cookie sessions. It owns
no tables and needs no `app.use(...)`. The hosting component in
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

In `convex/http.ts`, import the server build that Vite emits from `src/server.ts`, and let
`serveSite` serve the uploaded files and render every other path with it:

```ts
// Types of the server build imported below; the adapter owns them.
import type {} from "@samebase/convex-hosting-tanstack-start/server-build";
import server from "../dist/server/server.js";

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction((ctx, request) =>
    serveSite(ctx, components.hosting, request, versionId, async () => server.fetch(request)),
  ),
});
```

Vite names the entry `server.js` when the app's `package.json` has `"type": "module"`, and
`server.mjs` without it; import the name that the build emits. The `server-build` entry declares
both with the type of this package's server entry, so `convex/http.ts` typechecks before the first
build. It covers the default output only, `dist/server/server.js` and `.mjs`: an app that changes
`build.outDir` or the entry name declares its own path with one wildcard line, such as
`declare module "*/build/server/entry.js"` with the same default export. Leave `allowJs` out of
`convex/tsconfig.json`: with it, tsc reads the build instead of the type. `npx convex dev` bundles
`convex/http.ts` only after a build, so a fresh clone runs `convex-hosting deploy --dev` before its
first push, as the [README](https://github.com/samebase/convex-hosting#setup) says.

For reactive queries, use the
[official Convex TanStack integration](https://docs.convex.dev/client/tanstack/tanstack-start/).
Components use `useSuspenseQuery(convexQuery(...))`; the server entry waits for their HTML, and
TanStack handles query hydration.

To give the pages data of the request, pass it as `context`: `server.fetch(request, { context })`.
Start gives it to each route's `beforeLoad` and loader on the server as `serverContext`, typed as
`requestContext` in Start's `Register`. `fetch` is TanStack's `RequestHandler<Register>`: with a
registered `requestContext`, `context` is required and has that type.

## Convex Auth sessions

With [Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies,
`convex/http.ts` reads the session in `render` and passes its access token as the context, as the
[TanStack Start SSR example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
does:

```ts
// Type only, nothing is bundled: the request context this entry registers on TanStack's `Register`.
import type {} from "@samebase/convex-hosting-tanstack-start/convex-auth";

// In `render`, with the session of the request's cookies:
const token = await session.getToken();
const page = await server.fetch(request, { context: { token } });
```

`@samebase/convex-hosting-tanstack-start/convex-auth` has the rest, and loading it declares
`requestContext` as `{ token: string | null }` in the `Register` of `@tanstack/react-start`, which
makes `context` required and typed in `server.fetch` and gives every route a typed `serverContext`.
The `convex/` folder is its own TypeScript program, which is why `convex/http.ts` loads the entry
itself. The app creates its Convex client with `expectAuth: true`.

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

A pathless layout route gates the pages under it. This one sends the visitor to `/signin` with the
page in `next`, which `/signin` validates before it navigates there:

```tsx
import {
  RedirectWithoutSession,
  redirectWithoutSession,
} from "@samebase/convex-hosting-tanstack-start/convex-auth";

export const Route = createFileRoute("/_authed")({
  // A block body: with `search`, the return type of an expression body would depend on the route
  // tree, which contains this route, and TypeScript reports the cycle.
  beforeLoad: ({ serverContext, location }) => {
    redirectWithoutSession(serverContext, { to: "/signin", search: { next: location.href } });
  },
  component: () => (
    <RedirectWithoutSession to={(next) => ({ to: "/signin", search: { next } })}>
      <Outlet />
    </RedirectWithoutSession>
  ),
});
```

Without `next`, the gate is `redirectWithoutSession(serverContext, { to: "/signin" })` and
`<RedirectWithoutSession to="/signin">`.

- `sessionBeforeLoad`: on the server, the render's Convex HTTP client queries with the token, so
  loaders run as the user. It puts `token` in the route context.
- `SessionProvider`: Convex Auth's provider, started from the token of the server render. It also
  releases `expectAuth` for a visitor without a session, which Convex's provider never does.
- `redirectWithoutSession`: a server render without a session throws `redirect(options)`, with the
  options of TanStack's `redirect()`. Only the server render has the cookie; a browser navigation
  has no `serverContext`.
- `RedirectWithoutSession`: without a session, after it ends in this tab or in another one, or on a
  navigation inside the app to a gated page, renders nothing and navigates once to `to`, a path or
  the options that `to` builds from `next`, the gated page. The navigation replaces the history
  entry.
- `SignedIn` and `SignedOut`: render their children when the visitor is signed in, or signed out.
  Convex's provider reports loading during the server render and the hydration, so the token that
  `SessionProvider` was given decides until it settles, and both renders agree, where Convex's
  `Authenticated` and `Unauthenticated` render nothing on the server.
- `useSignOutSession(url)`: returns a function that posts to the app's sign-out route, such as
  `/auth/signout`, and only after a 2xx calls Convex Auth's `signOut()`, which clears the stored
  token in every tab, and reloads the page; otherwise it returns `false` and the session stays.
  Convex Auth's `signOut()` resolves even when the route failed, so a reload after it alone signs
  the user back in from the cookie.

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
