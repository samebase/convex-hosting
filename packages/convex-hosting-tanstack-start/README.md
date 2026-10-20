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

Convex Auth sessions in httpOnly cookies come from
[`@samebase/convex-auth-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-auth-tanstack-start),
which runs on any host. On Convex, its `convexAuth()` goes next to `convexSsr()`:
`plugins: [convexSsr(), convexAuth(), tanstackStart(), react()]`. Up to 0.10.2, this package had it
as the `convex-auth` entry, and `convexSsr()` included `convexAuth()`.

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
resolution.
