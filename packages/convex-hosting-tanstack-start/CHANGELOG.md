# Changelog

## 0.10.1

- `sessionBeforeLoad` accepts `serverContext: undefined`, which TanStack Start passes for a browser
  navigation, under `exactOptionalPropertyTypes`.

## 0.10.0

- The `convex-auth` entry targets Convex Auth 2.0.0-beta.0 exactly, and the optional
  `@convex-dev/auth` peer is pinned to it. beta.0 removed the `./nextjs` subpath. The entry imports
  `useAuthActions` from `@convex-dev/auth/react` and `ConvexAuthNextjsProvider` from
  `@convex-dev/auth/ssr/nextjs/client`, a specifier that the new `convexAuth()` Vite plugin resolves
  to `dist/ssr/nextjs/client.js`: the file that holds the provider, which imports no Next.js code
  and which beta.0's exports map does not expose. The upstream fix is an export
  (convex/convex-auth#350 and #126). `convexSsr()` includes `convexAuth()`; an app on another host,
  as the Workers twin, adds `convexAuth()` to its plugins. `convexAuth()` also inlines
  `@convex-dev/auth` in the dev server's render and pre-bundles the aliased file's imports, so the
  provider and the hooks share one copy of Convex Auth's React contexts and the first page load does
  not reload.
- What an app on 2.0.0-alpha.2 renames, as the examples do: `src/server.ts` imports `httpCookies`,
  `ServerAuthSession`, and `setupConvexAuthServer` from `@convex-dev/auth/ssr` (was
  `@convex-dev/auth/server`). `convex/convex.config.ts` imports `@convex-dev/auth/convex.config` and
  `@convex-dev/auth/components/anonymous/convex.config` (were `core/convex.config.js` and
  `providers/anonymous/convex.config.js`). `convex/auth.ts` calls `setupConvexAuth` from
  `@convex-dev/auth/server` (was `setupCore` from `core/setup`) and `setupAnonymous` from
  `@convex-dev/auth/methods/anonymous/server`, and exports `signInAnonymously` (was
  `signInAnonymous`). `getAuthUserId` comes from `@convex-dev/auth/server` (was `core`). The sign-in
  page calls `useSignInAnonymously(api.auth)` from `@convex-dev/auth/methods/anonymous/react` (was
  `useAnonymousAuth(api.auth.signInAnonymous)`). beta.0 changes the schema of the `auth/sessions`
  table: clear it before the first push, which signs every user out.
- OAuth sign-in under this entry is untested. After an OAuth code, the provider cleans the URL with
  code written for Next's router, which calls `history.replaceState(null, ...)` and can drop
  TanStack Router's history state.
- An app on Convex Auth 0.0.x stays on 0.9.x.

## 0.9.5

- `convexSsr()` adds `convex/react` and `@convex-dev/auth/nextjs` to the dev server's
  `optimizeDeps.include`, so the first page load no longer reloads mid-render with
  `Invalid hook call` (#45). TanStack Start keeps the adapter out of pre-bundling, so Vite did not
  see these imports of the `convex-auth` entry until a page used them. Without Convex Auth
  installed, Vite warns that `@convex-dev/auth/nextjs` does not resolve when it rebuilds its
  dependency cache.

## 0.9.4

- The `queueMicrotask` definition moved to `@samebase/convex-hosting` 0.13.0, so every handler gets
  it, not only TanStack Start. The server entry needs `@samebase/convex-hosting` 0.13.0 or later,
  which defines it; the peer is optional because the `convex-auth` entry alone, as on a Worker, does
  not need the core. The `node:stream` stub in `convexSsr()` stays here: it is build tooling for
  TanStack's server bundle.

## 0.9.3

0.9.2 was staged from the first commit of this fix and rejected before publication.

- The server entry defines `queueMicrotask` when the runtime has none. Convex's runtime has no
  `queueMicrotask`, and TanStack calls it on the server. `attachRouterServerSsrUtils` calls it once
  on every rendered page: the `ReferenceError` was swallowed and the page answered 200, but
  seroval's dispose step did not run. The ssr-query cache listener calls it for a query that starts
  after the first dehydrate, and that query's hydration data carried
  `ReferenceError: queueMicrotask is not defined`.
- The `URLSearchParams.size` definition is gone: Convex defines `size` now, on the cloud and on the
  local backend (version precompiled-2026-10-10-72ce13c).

## 0.9.1

- `@convex-dev/auth` is an optional peer dependency with no version range, so an app on Convex Auth
  0.0.x installs the adapter without `--legacy-peer-deps`; only the `convex-auth` entry needs Convex
  Auth 2. The README says the entry is interim, and that its `Register.server` context cannot be
  extended by the app today.
- npm metadata: homepage, bugs, keywords, and Node 22 or later.

## 0.9.0

- Pages stream, as on a Cloudflare Worker: the server entry is TanStack's own stream handler, the
  document goes out as it renders, and each Suspense boundary or deferred loader value follows in
  its own chunk. The entry no longer waits for the whole render, and the `progressiveChunkSize`
  override of 0.6.0 is gone with it. `convexSsr()` resolves `node:stream` to a stub for the server
  build: TanStack imports Node's stream classes for a branch that never runs where React's Web
  Stream renderer exists, and Convex's bundler had nothing to resolve them to.
- The request context's token may be `undefined`: a render that knows nothing about a session, the
  build's prerender, whose page every visitor gets. `SignedIn` and `SignedOut` wait for the browser
  on it, and `redirectWithoutSession` redirects it like a render without a session. The app's
  `src/server.ts` passes `undefined` for the prerender's requests, which it tells apart by the
  request header that `tanstackStart({ prerender: { headers } })` sends.

## 0.8.0

- The published manifest no longer lists `vite` in `devDependencies`. 0.5.0 to 0.7.0 listed it as
  `npm:@voidzero-dev/vite-plus-core@1.1.0`, and in an app installed with pnpm,
  `npm audit signatures` failed with
  `No matching version found for @voidzero-dev/vite-plus-core@<the app's vite version>`. `vite`
  stays a peer dependency, `*`: a Vite+ app resolves `vite` to Vite+'s core package at its own
  version numbers, so no Vite range fits both.
- The `react` and `react-dom` peers are `^19.2.0`. The server entry imports `renderToReadableStream`
  from `react-dom/server`, which React's Node build has from 19.2 on, so with an older React the dev
  server answered 500 on every page.
- The `@tanstack/react-start` peer is `^1.168.60`, the first version with the fix for
  GHSA-qx66-fv34-fjm8.

## 0.7.0

- The session lines move from `convex/http.ts` into the app's `src/server.ts`, around this package's
  `server` entry, so one file serves the Convex HTTP action, Vite's dev server, and a Cloudflare
  Worker. `convex/http.ts` forwards the `/auth` POST routes and the page render to it with
  `server.fetch(request)`, passes no context, and no longer loads the `convex-auth` entry. Vite's
  dev server then renders every page with the session, as production does.
- The types-only `server-build` entry declares `dist/server/server.js` and `.mjs` as a module whose
  default export is `{ fetch(request: Request): Promise<Response> }`, the shape of the app's
  `src/server.ts`, instead of the type of this package's server entry.

## 0.6.0

- The server entry renders with `progressiveChunkSize: Number.POSITIVE_INFINITY`. It sends the
  document only when it is complete, and React still outlined every Suspense boundary above 12.8 kB
  into a hidden segment with a reveal script: the content showed one frame late and the document was
  larger. Measured on a page with a 20 kB boundary: no hidden segment, 1 kB less.

## 0.5.0

- `convex-auth` no longer exports `useSignedIn`. `SignedIn` and `SignedOut` keep the same behavior.
- The server entry's `fetch` is TanStack's `RequestHandler<Register>`, so the request context is
  typed from `Register`: with the `convex-auth` registration, `context` is required and is
  `{ token: string | null }`. `convex/http.ts` loads the registration with
  `import type {} from "@samebase/convex-hosting-tanstack-start/convex-auth";` (type only, nothing
  is bundled) and passes `server.fetch(request, { context: { token } })` as before.

## 0.4.0

- `convexSsr()` no longer writes `.convex-hosting/server.js`; it only sets the `ssr` environment's
  options. `convex/http.ts` imports the server build directly, `../dist/server/server.js`. A fresh
  clone runs `npx convex dev --skip-push`, then `convex-hosting deploy --dev`, before its first
  `npx convex dev`.
- The types-only entry `@samebase/convex-hosting-tanstack-start/server-build` declares
  `dist/server/server.js` and `dist/server/server.mjs` with the type of the package's server entry.
  `convex/http.ts` loads it with
  `import type {} from "@samebase/convex-hosting-tanstack-start/server-build";`. It covers the
  default output only; an app with another output folder or entry name declares its own path.
- `useSignOutSession(url)` in `convex-auth` returns a sign-out function that posts to the app's
  sign-out route, and only after a 2xx calls Convex Auth's `signOut()`, which clears the stored
  token in every tab, and reloads the page; otherwise it returns `false`. Use it in place of
  `signOut()` followed by a reload: `signOut()` resolves even when the route failed, and the reload
  then signed the user back in from the cookie.

## 0.3.0

- After each server build, `convexSsr()` writes `.convex-hosting/server.js` in the working
  directory, where the `convex-hosting` CLI looks for it: a re-export of the server entry under the
  name that the build emitted. `convex/http.ts` imports `../.convex-hosting/server.js` instead of
  `../dist/server/server.js`, and `convex-hosting init` of `@samebase/convex-hosting` 0.6.0 writes a
  placeholder there, so `npx convex dev` works on a fresh clone before any build.
- The `server-build` types entry is gone: `@samebase/convex-hosting` 0.6.0 declares the new path.
  Remove it from `types` in `tsconfig.json` files, and leave `allowJs` out of
  `convex/tsconfig.json`.
- `redirectWithoutSession(serverContext, options)` takes the options of TanStack's `redirect()`,
  such as `{ to: "/signin", search: { next } }`, instead of a path.
- `RedirectWithoutSession` takes `to` as a path or as a function that builds the navigation options
  from `next`, the gated page, also after a navigation inside the app. It renders nothing without a
  session, redirects once, and its navigation replaces the history entry.
- `useSignedIn()`, `SignedIn`, and `SignedOut` tell a signed-in visitor apart in the server render
  too, from the token that `SessionProvider` was given.
- The `requestContext` declaration moves to the `Register` of `@tanstack/react-start`, where Start
  reads it. TypeScript 5.9 did not merge the declaration on `@tanstack/react-router` into it.

## 0.2.0

- `@samebase/convex-hosting-tanstack-start/server-build` declares the server entry that Vite emits.
  An app lists it in `types` in `convex/tsconfig.json` instead of writing the declaration itself.
- `@samebase/convex-hosting-tanstack-start/convex-auth` has the pieces of a Convex Auth cookie
  session: `sessionBeforeLoad` for the root route, `SessionProvider` around the document, and
  `redirectWithoutSession` with `RedirectWithoutSession` for a gate. Importing it declares Start's
  `requestContext` as `{ token: string | null }`. `@convex-dev/auth` is an optional peer dependency.

## 0.1.0

The first release: the `convexSsr()` Vite plugin and the server entry with
`fetch(request, { context })`.
