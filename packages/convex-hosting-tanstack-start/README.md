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

In `convex/http.ts`, import the server build that Vite emits from `src/server.ts`, and register the
site with it as the Worker: a file answers GET, another method on a file answers 405, and every
other request goes to the server, as it goes to a Cloudflare Worker:

```ts
import { routeAll } from "@samebase/convex-hosting";
// Type only, nothing is bundled: the server build imported below.
import type {} from "@samebase/convex-hosting-tanstack-start/server-build";
import server from "../dist/server/server.js";

routeAll(http, components.hosting, versionId, server);
```

Import `@samebase/convex-hosting` before the server build: it defines `queueMicrotask` when it
loads, because Convex's runtime has none, and TanStack calls it on the server once on every rendered
page and for a query that starts after the first dehydrate.

Vite names the entry `server.js` when the app's `package.json` has `"type": "module"`, and
`server.mjs` without it; import the name that the build emits. The `server-build` entry declares
both as a module whose default export is `{ fetch(request: Request): Promise<Response> }`, the shape
of the app's `src/server.ts`, so `convex/http.ts` typechecks before the first build. It covers the
default output only, `dist/server/server.js` and `.mjs`: an app that changes `build.outDir` or the
entry name declares its own path with one wildcard line, such as
`declare module "*/build/server/entry.js"` with the same default export. Leave `allowJs` out of
`convex/tsconfig.json`: with it, tsc reads the build instead of the type. `npx convex dev` bundles
`convex/http.ts` only after a build, so a fresh clone runs `convex-hosting deploy --dev` before its
first push, as the [README](https://github.com/samebase/convex-hosting#quick-start) says.

To give the pages data of the request, `src/server.ts` wraps this package's entry and passes it as
`context`: `handler.fetch(request, { context })`. Start gives it to each route's `beforeLoad` and
loader on the server as `serverContext`, typed as `requestContext` in Start's `Register`. `fetch` is
TanStack's `RequestHandler<Register>`: with a registered `requestContext`, `context` is required and
has that type. Vite's dev server calls `src/server.ts` too, so what it reads off the request holds
in development.

## Queries and loaders

Data comes through the
[official Convex TanStack integration](https://docs.convex.dev/client/tanstack/tanstack-start/):
`@convex-dev/react-query`, `@tanstack/react-query`, and `@tanstack/react-router-ssr-query`, whose
version follows `@tanstack/react-router`'s line (the example pins `1.167.3` next to router `1.170`).
`src/router.tsx` is Convex's quickstart setup, as in the
[example](https://github.com/samebase/convex-hosting/blob/main/examples/tanstack-ssr/src/router.tsx):
a `QueryClient` whose defaults come from `ConvexQueryClient`, `connect`, the router context, and
`setupRouterSsrQueryIntegration`.

A route declares its query options once and uses them twice. The loader ensures them, so they are
fetched in parallel before the render and on a link's intent, and TanStack keeps the current page on
screen until they are there. The component reads the same options with `useSuspenseQuery`, which the
server entry awaits, so the first HTML carries the data, and the browser then keeps the query live.
One `queryClient.query` per entry: a loop over the record does not typecheck, because each entry has
its own result type. `convexQuery` sets `staleTime: Infinity`, so `query` returns the cached data
when it has it and fetches otherwise; TanStack Query 5.103 deprecates `ensureQueryData` for it.

```ts
// DayPage.queries.ts
export const dayQueries = (date: string) => ({
  stools: convexQuery(api.stools.list, { trackedAtPrefix: date }),
  tags: convexQuery(api.tags.list, {}),
});

// routes/day.$date.tsx
loader: async ({ context: { queryClient }, params }) => {
  const q = dayQueries(params.date);
  await Promise.all([queryClient.query(q.stools), queryClient.query(q.tags)]);
},

// DayPage.tsx
const { data: stools } = useSuspenseQuery(dayQueries(date).stools);
```

The declaration lives next to the page component, not in its module: the loader is eager route code,
and when it imports the options from the page module, `autoCodeSplitting` puts the page into the
entry chunk (measured on one app: 648 kB to 909 kB). `useSuspenseQuery` alone also server-renders
the data; the loader adds the parallel fetch and the preload.

## Convex Auth sessions

This entry is interim: the session lines are Convex Auth's own API, and their home is a TanStack
Start integration in Convex Auth itself, which is being discussed with Convex. Until then they live
here, and they need Convex Auth 2.0.0-beta.0 exactly (`@convex-dev/auth@2.0.0-beta.0`, npm tag
`beta`). That beta signs in with email and password, with sign-up verification and password recovery
by email link, sent through Resend only; it has no magic links and no email codes (OTP) yet.

The entry imports Convex Auth's SSR provider from a file that beta.0's exports map does not expose.
`convexSsr()` includes `convexAuth()`, the Vite plugin that resolves it; an app on another host,
such as a Cloudflare Worker, adds `convexAuth()` from `@samebase/convex-hosting-tanstack-start/vite`
to its plugins.

With [Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies,
`src/server.ts` answers the `/auth` routes, reads the session of the request's cookies, and passes
its access token as the context, as the
[TanStack Start SSR example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
does in its
[`src/server.ts`](https://github.com/samebase/convex-hosting/blob/main/examples/tanstack-ssr/src/server.ts):

```ts
const token = request.headers.has("x-prerender") ? undefined : await session.getToken();
const page = await handler.fetch(request, { context: { token } });
```

The build's prerender renders a page without a visitor, and every visitor gets that page, so its
render must not say signed out. TanStack's prerender sends the request headers of
`tanstackStart({ prerender: { headers } })`; the example sets one, and `src/server.ts` gives such a
request no token at all. `SignedIn` and `SignedOut` then wait for the browser on that page, and a
gate redirects it as it redirects a request without a session.

`convex/http.ts` then forwards every request that is not a GET, and the page render, to the build
with `server.fetch(request)`, as the example's
[`convex/http.ts`](https://github.com/samebase/convex-hosting/blob/main/examples/tanstack-ssr/convex/http.ts)
does. `@samebase/convex-hosting-tanstack-start/convex-auth` has the rest, and loading it declares
`requestContext` as `{ token: string | null | undefined }` in the `Register` of
`@tanstack/react-start`, which makes `context` required and typed in `handler.fetch` and gives every
route a typed `serverContext`. The token is `undefined` for a render that knows nothing about a
session, the prerender. The app creates its Convex client with `expectAuth: true`.

Nothing in this entry is about hosting: it is the TanStack Start integration that Convex Auth does
not ship, and the
[Cloudflare Workers twin](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr-workers)
of the SSR example uses it unchanged. It lives here next to its first user until it exists upstream
as `@convex-dev/auth/tanstack-start`.

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

`@convex-dev/auth` is an optional peer dependency pinned to 2.0.0-beta.0: only the `convex-auth`
entry uses it, and `convexAuth()` resolves a file inside that version. An app with another auth
provider installs the adapter as is and does not import the entry; an app on Convex Auth 0.0.x stays
on adapter 0.9.x. The server entry needs `@samebase/convex-hosting` 0.13.0 or later, which defines
`queueMicrotask`; the peer is optional because the `convex-auth` entry alone, as on a Worker, does
not need the core.

The entry declares Start's `Register.server` with a request context that holds only the token, so an
app that uses the entry cannot add its own fields to `serverContext` today; an app that needs that
is the signal to make the context a type the app registers itself.

## Why these settings exist

- `worker` selects TanStack's server exports; `browser` selects Web API adapters.
- `react-dom/server.edge` avoids the browser renderer's `MessageChannel` dependency.
- `ssr.noExternal` bundles dependencies instead of leaving runtime Node imports.
- `node:stream` resolves to a stub. TanStack's stream renderer imports Node's stream classes at the
  top of its files for a branch that runs only where React has no Web Stream renderer; on Convex
  that renderer exists, the branch never runs, and the bundler has no `node:stream`. The stub's
  classes throw if anything calls them.
- The server entry is TanStack's own stream handler, so pages stream as they do on a Worker: the
  document goes out as it renders, and each Suspense boundary or deferred loader value follows in
  its own chunk. A client that TanStack takes for a bot, by its user agent, gets the whole document.

These settings apply to builds. Development and Node-based tests keep their normal dependency
resolution, except for `convexAuth()`, which applies to both:

- `@convex-dev/auth/ssr/nextjs/client` resolves to the file of Convex Auth 2.0.0-beta.0 that holds
  `ConvexAuthNextjsProvider`. The file imports no Next.js code; only beta.0's exports map hides it.
- `@convex-dev/auth` is inlined in the server render, so the dev server does not load the aliased
  file through Vite and the rest of Convex Auth through Node, each with its own copy of the React
  contexts that the provider sets and the hooks read.
- The dev server pre-bundles the entry's browser imports and those of the aliased file, so the first
  page load does not find them late and reload.
