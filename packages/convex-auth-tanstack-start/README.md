# @samebase/convex-auth-tanstack-start

[Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies for a TanStack
Start app that renders on the server: the session provider, the root route's `beforeLoad`, the gates
of private pages, `SignedIn` and `SignedOut`, sign-out, and OAuth sign-in. Nothing in it is about
hosting: it is the TanStack Start integration that Convex Auth does not ship (it ships
`@convex-dev/auth/ssr/nextjs`), and it runs unchanged on any host. The
[TanStack Start SSR example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
uses it on Convex, with
[`@samebase/convex-hosting-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start),
and its
[Cloudflare Workers twin](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr-workers)
uses it on a Worker.

## Use

Add `convexAuth()` to the plugins in `vite.config.ts`, next to the host's own:

```ts
import { convexAuth } from "@samebase/convex-auth-tanstack-start/vite";

// On Convex:
plugins: [convexSsr(), convexAuth(), tanstackStart(), react()],
// On a Cloudflare Worker:
plugins: [convexAuth(), cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react()],
```

Convex Auth 2.0.0-beta.0 keeps its SSR provider in a file that its exports map does not expose, and
`convexAuth()` resolves it; [Why these settings exist](#why-these-settings-exist) has the rest.

## Sessions

This package is interim: the session lines are Convex Auth's own API, and their home is a TanStack
Start integration in Convex Auth itself, which is being discussed with Convex. Until then they live
here, and they need Convex Auth 2.0.0-beta.0 exactly (`@convex-dev/auth@2.0.0-beta.0`, npm tag
`beta`). That beta signs in with OAuth providers ([OAuth sign-in](#oauth-sign-in)), and with email
and password, with sign-up verification and password recovery by email link, sent through Resend
only; it has no magic links and no email codes (OTP) yet.

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

On Convex, `convex/http.ts` then forwards every request that is not a GET, and the page render, to
the build with `server.fetch(request)`, as the example's
[`convex/http.ts`](https://github.com/samebase/convex-hosting/blob/main/examples/tanstack-ssr/convex/http.ts)
does; on a Worker, `src/server.ts` is the Worker. This package has the rest, and loading it declares
`requestContext` as `{ token: string | null | undefined }` in the `Register` of
`@tanstack/react-start`, which makes `context` required and typed in `handler.fetch` and gives every
route a typed `serverContext`. The token is `undefined` for a render that knows nothing about a
session, the prerender. The app creates its Convex client with `expectAuth: true`.

The root route gives the token to the server render's Convex client and wraps the document in the
session provider:

```tsx
import { SessionProvider, sessionBeforeLoad } from "@samebase/convex-auth-tanstack-start";

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
} from "@samebase/convex-auth-tanstack-start";

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
  releases `expectAuth` for a visitor without a session, which Convex's provider never does, and it
  finishes OAuth flows, as [OAuth sign-in](#oauth-sign-in) says.
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

`@convex-dev/auth` is a peer dependency pinned to 2.0.0-beta.0, because `convexAuth()` resolves a
file inside that version. An app on Convex Auth 0.0.x stays on
`@samebase/convex-hosting-tanstack-start` 0.9.x, which had these helpers in its `convex-auth` entry.

The package declares Start's `Register.server` with a request context that holds only the token, so
an app that uses it cannot add its own fields to `serverContext` today; an app that needs that is
the signal to make the context a type the app registers itself.

## OAuth sign-in

`SessionProvider` registers Convex Auth's OAuth client, so Convex Auth's own hooks work as its docs
say: `useSignInWithGithub(api.auth)` from `@convex-dev/auth/methods/github/react`,
`useSignInWithGoogle`, `useOauthSignIn` for another provider, and `useOauth()` for the error of a
flow. Only the URL cleanup differs. `ConvexAuthNextjsProvider` cleans the URL for Next's router: on
the next tick it replaces the URL again with a `null` history state, which drops the key and the
index that TanStack Router keeps there for scroll restoration and back and forward. This package
replaces the URL once and keeps the state.

A sign-in with GitHub under cookie sessions:

1. `signIn()` calls `startSignInWithGithub` on the deployment, which mints no session, saves the
   flow's state in `localStorage`, and leaves for GitHub. The flow returns to the current page,
   unless `signIn({ redirectTo })` names another one.
2. GitHub sends the browser to the component's callback, `<CONVEX_SITE_URL>/auth/github/callback`.
   The component exchanges GitHub's code and redirects to the return page with a one-time
   `?convexAuthCode`, or with `?convexAuthError`.
3. The server renders the return page without a session. After hydration, the provider removes the
   parameter from the URL and redeems the code with `completeSignInWithGithub` through the app's
   `/auth/signin` route, which keeps the refresh token in its httpOnly cookie and gives the browser
   the access token. `SignedIn` renders, and the next request renders as the user.

The app wires each provider in four places, here GitHub:

- `convex/convex.config.ts` installs the provider's component with an `httpPrefix`, which makes its
  callback URL `<CONVEX_SITE_URL><httpPrefix>/callback`:

  ```ts
  app.use(github, {
    httpPrefix: "/auth/github",
    env: {
      CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
      CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
    },
  });
  ```

  Google goes under `/auth/google` the same way. Convex Auth's docs use `/oauth/github`; any prefix
  works that no route of the app uses, and `/auth/github` keeps the providers next to the core's
  `/auth`. The component's variables are required, and Convex refuses a push that binds them to
  optional variables of the app, so every deployment needs them, previews included.

- `convex/auth.ts` exports the provider's two functions, with the origin of the site in
  `allowedRedirectOrigins`:

  ```ts
  export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(core, {
    component: components.authGithub,
    allowedRedirectOrigins: [env.CONVEX_SITE_URL],
  }).attachUserCallbacks({ createUser: internal.users.createUserGithub });
  ```

  `createUserGithub` is an internal mutation that takes
  `provider: v.object({ name: v.literal("github"), accountId: v.string(), profile: vGithubProfile })`,
  with `vGithubProfile` from `@convex-dev/auth/methods/github/server`, and returns the new user's
  id.

- `src/server.ts` adds each `completeSignIn*` function to the `signIn` list of
  `setupConvexAuthServer`. The `startSignIn*` functions stay out: they mint no session, and the
  client calls them on the deployment.
- A button calls the hook's `signIn()`, and the page shows `useOauth().flowError`.

`convex/http.ts` keeps its order: `routeAll(...)` first, which returns the handler, then the exact
`POST` routes for `/auth/signin`, `/auth/refresh`, and `/auth/signout` on that handler. The
components' prefixes come from `convex/convex.config.ts`, not from `http.ts`. For each request,
Convex takes an exact route of the app first, then the longest prefix among the app's prefixes and
the components' `httpPrefix`: `/auth/github/callback` goes to the GitHub component, the key set
under `/auth` to the core, the three exact routes to the app's server, and every other path to the
catch-all of `routeAll`.

`useOauth().flowError` says why the last flow failed after the provider sent the browser back, or is
`null`. The app switches on `error` and supplies its own text:

- `ACCESS_DENIED`: the user cancelled at the provider.
- `EXPIRED`: the flow took too long, or its code was redeemed already or does not match the flow
  that this browser saved.
- `INVALID_FLOW`: this browser has no saved flow: another browser started it, or it finished.
- `REJECTED`: the app's `createUser` or `onSignIn` threw a `ConvexError`; `data` is its data.
- `OTHER_ERROR`: anything else, such as a failed exchange with the provider or a redemption that
  threw; `cause` holds it.

A start that fails before the provider, such as a `redirectTo` whose origin is not in
`allowedRedirectOrigins`, comes back from `signIn()` as
`{ status: "error", userError: { error: "OTHER_ERROR", cause } }` instead.

What the app must not do:

- Return the flow to a page that redirects on the server, such as a gated page. The server has no
  session yet, so `redirectWithoutSession` sends the browser to the sign-in page without the code,
  and the flow never finishes. Return to a page that renders without a session, and move on once
  `SignedIn` renders; a document load, `location.assign(...)`, renders the next page as the user.
- Route a path under a component's prefix in `convex/http.ts`: an exact route, or a longer prefix,
  wins over the component's prefix and can take its callback.
- Leave a `completeSignIn*` function out of `signIn`: the route answers 403, and the flow ends in
  `OTHER_ERROR`.

## Why these settings exist

`convexAuth()` applies to development and builds:

- `@convex-dev/auth/ssr/nextjs/client` resolves to the file of Convex Auth 2.0.0-beta.0 that holds
  `ConvexAuthNextjsProvider`. The file imports no Next.js code; only beta.0's exports map hides it.
- `@convex-dev/auth` is inlined in the server render, so the dev server does not load the aliased
  file through Vite and the rest of Convex Auth through Node, each with its own copy of the React
  contexts that the provider sets and the hooks read.
- The dev server pre-bundles the package's browser imports and those of the aliased file, so the
  first page load does not find them late and reload.
