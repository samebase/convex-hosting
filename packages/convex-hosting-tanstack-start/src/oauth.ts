// The OAuth ambient sign-in of the `convex-auth` entry: Convex Auth's own, with a URL cleanup that
// TanStack Router survives.

import { oauth } from "@convex-dev/auth/methods/oauth/react";

/**
 * Convex Auth's `oauth()` ambient sign-in. On the page that a provider's callback redirects to, it
 * reads `?convexAuthCode` or `?convexAuthError`, removes both from the URL, and redeems the code
 * with the provider's `completeSignIn*` mutation through the provider's sign-in API. Under
 * `ConvexAuthNextjsProvider` that API is the app's `/auth/signin` route, so the session lands in
 * the cookies. A failure goes to `useOauth().flowError`.
 *
 * Only the URL cleanup is different. `ConvexAuthNextjsProvider` gives its ambient sign-ins a
 * cleanup written for Next's router, which replaces the URL and then, on the next tick, replaces it
 * again with a `null` history state. TanStack Router keys each history entry on its state
 * (`__TSR_key`, `__TSR_index`): after the `null` replace, scroll restoration does not find the
 * entry, and the entry's index is 0, so `canGoBack` and the back and forward detection are wrong.
 * This cleanup replaces the URL once and keeps the state, as Convex Auth's own `ConvexAuthProvider`
 * does. TanStack Router's browser history wraps `history.replaceState`, so the router reads the
 * cleaned URL with the same entry.
 */
export function oauthKeepingHistoryState(): ReturnType<typeof oauth> {
  const convexOauth = oauth();
  return {
    id: convexOauth.id,
    setup: (context) =>
      convexOauth.setup({
        ...context,
        replaceUrl: (url) => window.history.replaceState(window.history.state, "", url),
      }),
  };
}
