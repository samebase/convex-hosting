# TanStack Start SSR example

Live at [gallant-llama-40.convex.site](https://gallant-llama-40.convex.site), deployed from `main`.

TanStack Start pages rendered inside a Convex HTTP action, with
[Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies.
`convex/http.ts` serves the browser files with `routeAll` and hands every other path to the server
build of `src/server.ts`, which renders it through
[`@samebase/convex-hosting-tanstack-start`](../../packages/convex-hosting-tanstack-start), with the
sessions of [`@samebase/convex-auth-tanstack-start`](../../packages/convex-auth-tanstack-start). The
example has its own schema, so it needs its own Convex project.

## Kinds of pages

The demo data is a to-do list in `convex/todos.ts`, after the one in `samebase/base`: each anonymous
user gets a readable name when it is created, todos have an author and a done state, and a public
site needs caps on text length and todos per user.

- `/about`: a static file from the build. `vite.config.ts` has TanStack Start prerender this page
  only, into `dist/client/about/index.html`, and `routeAll` serves it like any other file. As on
  Cloudflare, `/about` answers 307 to `/about/`, which answers the file with an ETag and
  `Cache-Control: public, max-age=0, must-revalidate`, where a rendered page answers `no-store`. A
  navigation inside the app renders the route in the browser like any other, so a prerendered route
  keeps no request-time data.
- `/`: rendered per request, and needs no session. The first HTML response contains the latest
  twenty todos of all users with their authors from `todos.latest`, and the list stays live after
  React hydrates. Each has a Remove button for anyone, through `todos.remove`: the demo is public,
  and whoever sees something out of place takes it down.
- `/todos`: rendered as the user. The first HTML response contains the user's todos from
  `todos.list`, the form adds one with `todos.add`, and a checkbox toggles `todos.toggle`. The page
  sits behind the pathless layout in `src/routes/_authed.tsx`: without a session, the server
  redirects to `/signin`, and the browser does the same when the session ends.
- `/signin`: a button that signs in anonymously and opens `/todos`.
- `/stream`: the loader returns a promise that resolves two seconds later, without awaiting it. The
  document goes out at once with a fallback, and the value follows in a later chunk, as on a Worker;
  the header's link requests the document, because a navigation inside the app would run the loader
  in the browser.
- `/server`: a server function that answers with what the server saw, a server function that
  redirects to `/about`, and a server route at the same path that takes a form upload. The request
  middleware in `src/start.ts` puts `Cache-Control: no-store` on every answer Start gives, pages and
  these included.
- The header on every page: the root route's loader queries `users.me`, so the first HTML response
  of a rendered page shows `Signed in as <name>` with a sign-out button, or a link to `/signin`. The
  build has no session, so on `/about` the header fills in after React hydrates.

## Sessions

The refresh token lives in an httpOnly cookie; browser code holds only the access token, which
expires after 60 seconds. For each page, `src/server.ts` reads the cookies, refreshes the access
token when it expires within 10 seconds (the refresh rotates both cookies), renders the page with
`handler.fetch(request, { context: { token } })`, and returns the page with the rotated cookies. The
rest comes from [`@samebase/convex-auth-tanstack-start`](../../packages/convex-auth-tanstack-start).
The root route's `beforeLoad`, `sessionBeforeLoad`, gives the token to the Convex HTTP client of the
server render, so the page's queries run as the user. In the browser, `SessionProvider` wraps Convex
Auth's `ConvexAuthNextjsProvider` (it contains no Next.js code), which starts from the token of the
server render and calls `POST /auth/signin` and `/auth/refresh` in `src/server.ts`. The sign-out
button calls `/auth/signout` through that package's `useSignOutSession`, which clears the session
and reloads only when the route succeeded, and otherwise shows that sign-out failed. `expectAuth`
makes the browser's Convex client wait for a token before its first subscription, so a page rendered
as the user gets the user's live answer, and it never releases for a visitor without a session.
Convex's AuthKit template decides `expectAuth` on the server per request; TanStack creates the
client before the page knows the session, so `SessionProvider` releases it when the provider reports
none. `expectAuth` holds queries only before the first authentication, so sign-out reloads the page.

The example signs in anonymously: each sign-in creates a user. Password sign-in changes the provider
in `convex/convex.config.ts` and `convex/auth.ts`, the `signIn: [...]` list in `src/server.ts`, and
the button on `/signin`. The other routes stay the same. OAuth sign-in adds a provider's component,
its functions, its `completeSignIn*` function in the `signIn` list, and a button, as that package's
[OAuth sign-in](../../packages/convex-auth-tanstack-start/README.md#oauth-sign-in) says.

## Where code goes

TanStack Start is the renderer here, and Convex is the backend. `src/server.ts` is the server entry,
what the Worker is on Cloudflare: it answers the `/auth` routes, reads the cookies, gives the render
its request context, and returns the page. `convex/http.ts` serves the files and calls it for
everything else; Vite's dev server calls it directly.

- Pages, loaders, `head`, and prerender live in `src/routes`.
- Data and endpoints live in `convex/`. A Convex query or mutation is what a TanStack server
  function would be, with `ctx` and the user's identity, and the browser subscribes to it live. The
  `/auth` routes live in `src/server.ts`, because the session cookies belong to the site's origin.
- Request work, such as the cookies and the token, happens in `src/server.ts` before
  `handler.fetch`, not in TanStack middleware.
- `/server` shows a server function, a server route, and request middleware. They run inside the
  HTTP action and call Convex over HTTP for data, so a Convex query or mutation stays the place for
  data.
- A loader of the server render reaches Convex through the HTTP client with the user's token: the
  cookie is not an `Authorization` header, so the HTTP action itself has no identity.

## Set up

From `examples/tanstack-ssr`:

In one terminal, kept running:

```sh
pnpm install
npx convex dev                    # creates your dev deployment and .env.local; its first push fails
```

In another:

```sh
npx @convex-dev/auth              # new deployment only: sets AUTH_PRIVATE_KEY and AUTH_JWKS on it
pnpm run deploy:dev               # builds, uploads, writes .convex-hosting/version.js, pushes
```

The example commits `convex/_generated`, as Convex recommends, so a fresh clone can build:
`npx convex dev` does not write it before its first push, and `npx convex codegen` bundles
`convex/http.ts`, so on a fresh clone it fails with the "Could not resolve" error below.

`convex/http.ts` imports `dist/server/server.js` and `.convex-hosting/version.js`, which only
`deploy:dev` writes. If `dist/` or `.convex-hosting/` is deleted later, `npx convex dev` fails with
a clear "Could not resolve" error, and `pnpm run deploy:dev` fixes it. `deploy:dev` prints the site
URL when it ends.

Local deployment (anonymous or `--local`): the backend runs inside `npx convex dev`, so the first
terminal must stay open while `deploy:dev` uploads, else the upload fails with `fetch failed`.

Production needs its own key pair on the production deployment before the first `pnpm run deploy`.

## Previews

`.github/workflows/preview-examples.yml` deploys each pull request to a Convex preview deployment
named after its branch, through [`actions/preview`](../../actions/preview/action.yml), and the pull
request shows the site URL as a deployment. A second push reuses the deployment, and closing the
pull request deletes it ([`actions/cleanup`](../../actions/cleanup/action.yml)). Convex deletes a
preview deployment some days after its creation (five on the free plan), and the hosting component's
files go with it. The workflow needs two things once per project:

- A preview deploy key, as the repository secret `CONVEX_PREVIEW_DEPLOY_KEY_TANSTACK_SSR`. The
  dashboard creates one under Project Settings, and so does the platform API
  (`POST /v1/projects/<id>/create_preview_deploy_key`).
- The signing keys as the project's defaults for preview deployments, which Convex copies into each
  new preview before the first push:
  `npx convex env default set --type preview AUTH_PRIVATE_KEY ...` and the same for `AUTH_JWKS`. Use
  a pair of their own, not the production pair.

## Commands

- `pnpm run dev`: Vite's dev server, with `npx convex dev` in another terminal. Vite calls
  `src/server.ts`, so the `/auth` routes answer on the dev origin and the pages render with the
  session, as on the deployment.
- `pnpm run build`: build the browser files into `dist/client` and the server into `dist/server`,
  and prerender `/about`.
- `pnpm run deploy:dev`: build, upload, and push to the development deployment.
- `pnpm run deploy`: build, upload, and push to production.

For everything else, see the [README](../../README.md).
