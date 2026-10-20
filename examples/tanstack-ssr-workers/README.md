# TanStack Start SSR example on Cloudflare Workers

Live at
[convex-hosting-tanstack-ssr-workers.pfp.workers.dev](https://convex-hosting-tanstack-ssr-workers.pfp.workers.dev),
deployed from `main`.

The app of [`examples/tanstack-ssr`](../tanstack-ssr), deployed as a Cloudflare Worker with static
assets instead of on Convex. Convex stays the backend. The files that differ between the two
folders, the READMEs and `convex/_generated` aside, are what is specific to convex-hosting; CI fails
on any other difference.

TanStack Start pages rendered in a Worker, with
[Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies. Cloudflare
serves the browser files, and `src/server.ts`, the Worker, answers the `/auth` routes and renders
every other path with TanStack Start's server entry. The example has its own schema, so it needs its
own Convex project.

## Kinds of pages

The demo data is a to-do list in `convex/todos.ts`, after the one in `samebase/base`: each anonymous
user gets a readable name when it is created, todos have an author and a done state, and a public
site needs caps on text length and todos per user.

- `/about`: a static file from the build. `vite.config.ts` has TanStack Start prerender this page
  only, into `dist/client/about/index.html`, and Cloudflare serves it like any other file: `/about`
  answers 307 to `/about/`, which answers the file with an ETag and
  `Cache-Control: public, max-age=0, must-revalidate`. The prerender runs through the Worker with
  the header that `tanstackStart({ prerender: { headers } })` sends, so `src/server.ts` passes
  `undefined` as the token and the render sends no query to Convex. `SignedIn` and `SignedOut` wait
  for the browser on that page instead of saying signed out. A navigation inside the app renders the
  route in the browser like any other, so a prerendered route keeps no request-time data.
- `/`: rendered per request, and needs no session. The first HTML response contains the latest
  twenty todos of all users with their authors from `todos.latest`, and the list stays live after
  React hydrates. Each has a Remove button for anyone, through `todos.remove`: the demo is public,
  and whoever sees something out of place takes it down.
- `/todos`: rendered as the user. The first HTML response contains the user's todos from
  `todos.list`, the form adds one with `todos.add`, and a checkbox toggles `todos.toggle`. The page
  sits behind the pathless layout in `src/routes/_authed.tsx`: without a session, the server
  redirects to `/signin`, and the browser does the same when the session ends.
- `/signin`: a button that signs in anonymously and opens `/todos`.
- The header on every page: the root route's loader queries `users.me`, so the first HTML response
  of a rendered page shows `Signed in as <name>` with a sign-out button, or a link to `/signin`. The
  build has no session, so on `/about` the header fills in after React hydrates.

## Sessions

The refresh token lives in an httpOnly cookie; browser code holds only the access token, which
expires after 60 seconds. For each page, `src/server.ts` reads the cookies, refreshes the access
token when it expires within 10 seconds (the refresh rotates both cookies), renders the page with
`handler.fetch(request, { context: { token } })`, and returns the page with the rotated cookies. The
rest comes from the adapter's `convex-auth` entry. The root route's `beforeLoad`,
`sessionBeforeLoad`, gives the token to the Convex HTTP client of the server render, so the page's
queries run as the user. In the browser, `SessionProvider` wraps Convex Auth's
`ConvexAuthNextjsProvider` (it contains no Next.js code), which starts from the token of the server
render and calls `POST /auth/signin` and `/auth/refresh` in `src/server.ts`. The sign-out button
calls `/auth/signout` through the adapter's `useSignOutSession`, which clears the session and
reloads only when the route succeeded, and otherwise shows that sign-out failed. `expectAuth` makes
the browser's Convex client wait for a token before its first subscription, so a page rendered as
the user gets the user's live answer, and it never releases for a visitor without a session.
Convex's AuthKit template decides `expectAuth` on the server per request; TanStack creates the
client before the page knows the session, so `SessionProvider` releases it when the provider reports
none. `expectAuth` holds queries only before the first authentication, so sign-out reloads the page.

The cookies are `Secure` when the request came over HTTPS, and not in `pnpm run dev`, which serves
plain HTTP.

The example signs in anonymously: each sign-in creates a user. Password sign-in changes the provider
in `convex/convex.config.ts` and `convex/auth.ts`, the `signIn: [...]` list in `src/server.ts`, and
the button on `/signin`. The other routes stay the same. OAuth is not wired in the adapter's
`convex-auth` entry yet.

## Where code goes

TanStack Start is the renderer here, and Convex is the backend. `src/server.ts` is the Worker: it
answers the `/auth` routes, reads the cookies, gives the render its request context, and returns the
page.

- Pages, loaders, `head`, and prerender live in `src/routes`.
- Data and endpoints live in `convex/`. A Convex query or mutation is what a TanStack server
  function would be, with `ctx` and the user's identity, and the browser subscribes to it live. The
  `/auth` routes live in the Worker, because the session cookies belong to the site's origin.
- Request work, such as the cookies and the token, happens in `src/server.ts` before
  `handler.fetch`, not in TanStack middleware.
- `/server` shows a server function, a server route, and request middleware. They run inside the
  Worker and call Convex over HTTP for data, so a Convex query or mutation stays the place for data.
- A loader of the server render reaches Convex through the HTTP client with the user's token: the
  cookie is not an `Authorization` header, so the Worker itself has no identity.

## Set up

From `examples/tanstack-ssr-workers`:

```sh
pnpm install
npx convex dev --skip-push        # creates your dev deployment and .env.local, no push
npx @convex-dev/auth              # new deployment only: sets AUTH_PRIVATE_KEY and AUTH_JWKS on it
npx convex dev                    # pushes, then work as usual
pnpm run dev                      # in a second terminal
```

Production needs its own key pair on the production deployment before the first deploy.

The Cloudflare Vite plugin passes the values of `.env.local` to the local Worker as variables and
copies them into `dist/server/.dev.vars`; `wrangler deploy` does not upload that file.

## Deploy

Cloudflare Workers Builds deploys the example from this repository: production from `main`, and a
Preview for every other branch.
[docs/workers.md](../../docs/workers.md#the-same-app-on-cloudflare-workers) lists the settings.
Workers Builds runs `pnpm run build`, which runs `convex deploy --cmd "vp build"` when `WORKERS_CI`
is `1`. The Convex CLI reads `WORKERS_CI_BRANCH` itself: with the project's preview deploy key it
deploys to a preview deployment named after the branch, and it refuses a production deploy key on
any branch but `main`. `convex deploy` gives the build `VITE_CONVEX_URL` and pushes after it. Then
Workers Builds runs `pnpm run deploy` (`wrangler deploy`) on `main` and `pnpm run deploy:preview`
(`wrangler preview`) on other branches. Both read the configuration that the build wrote to
`dist/server/wrangler.json`.

The preview deployments need the signing keys as the project's defaults for preview deployments,
which Convex copies into each new preview before the first push:
`npx convex env default set --type preview AUTH_PRIVATE_KEY ...` and the same for `AUTH_JWKS`. Use a
pair of their own, not the production pair.

## Commands

- `pnpm run dev`: Vite's dev server, with the Worker in Cloudflare's runtime, and `npx convex dev`
  in another terminal. The Worker answers `/auth/` itself, so sign-in and sign-out work, the session
  cookies belong to the dev origin, and pages render with the session.
- `pnpm run build`: build the browser files into `dist/client` and the Worker into `dist/server`,
  and prerender `/about`. Inside Workers Builds, deploy Convex around the build.
- `npx wrangler dev`: serve the build locally.
- `pnpm run deploy`, `pnpm run deploy:preview`: the deploy commands of Workers Builds.

For everything else, see the [README](../../README.md).
