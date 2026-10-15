# Changelog

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
- `signOutSession(url)` in `convex-auth` posts to the app's sign-out route and reloads the page only
  when the route answers 2xx; otherwise it returns `false`. Use it in place of Convex Auth's
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
