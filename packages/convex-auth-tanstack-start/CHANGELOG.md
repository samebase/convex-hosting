# Changelog

## 0.1.1

- `useSignOutSession(url, landingUrl)` loads `landingUrl` after the sign-out instead of reloading
  the page. A reload asked the server for the private page the visitor signed out on, and the app's
  gate answered with its sign-in redirect, so the visitor landed on `/?next=/settings`.

## 0.1.0

- The `convex-auth` entry of `@samebase/convex-hosting-tanstack-start` 0.10.2, as a package of its
  own, and its `convexAuth()` Vite plugin as `./vite`. The exports and their behavior are the same:
  `SessionProvider`, `sessionBeforeLoad`, `SignedIn`, `SignedOut`, `redirectWithoutSession`,
  `RedirectWithoutSession`, `useSignOutSession`, and the `Register.server` request context. An app
  imports them from `@samebase/convex-auth-tanstack-start` and adds `convexAuth()` to its plugins
  itself, also on Convex, where `convexSsr()` included it.
- OAuth sign-in works. `SessionProvider` registers Convex Auth's `oauth()` ambient sign-in, which
  the adapter's 0.10.2 turned off, with one change: its URL cleanup replaces the URL once and keeps
  `history.state`, where `ConvexAuthNextjsProvider`'s cleanup for Next's router replaces it again
  with a `null` state on the next tick, which drops the `__TSR_key` and `__TSR_index` that TanStack
  Router keeps there. The code exchange is Convex Auth's own: after the provider's callback, the
  browser redeems `?convexAuthCode` with the provider's `completeSignIn*` mutation through the app's
  `/auth/signin` route, so the session lands in the cookies. Convex Auth's hooks work as documented:
  `useSignInWithGithub`, `useSignInWithGoogle`, `useOauthSignIn`, and `useOauth()`, whose
  `flowError` is `ACCESS_DENIED`, `EXPIRED`, `INVALID_FLOW`, `REJECTED`, or `OTHER_ERROR`.
- What an app adds for a provider, such as GitHub: the component with an `httpPrefix`
  (`"/auth/github"`), its two variables on every deployment (Convex refuses to bind the component's
  required variables to optional ones), `allowedRedirectOrigins` with the site's origin, and the
  `completeSignIn*` function in the `signIn` list of `src/server.ts`. The README's "OAuth sign-in"
  section has the flow, the order in `convex/http.ts`, and what the app must not do.
- `convexAuth()` pre-bundles `@convex-dev/auth/methods/oauth/react` for the dev server, so the first
  page load does not reload.
- `@convex-dev/auth` is a required peer, pinned to 2.0.0-beta.0.
