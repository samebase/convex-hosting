# TanStack Start SSR example

TanStack Start pages rendered inside a Convex HTTP action, with
[Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies.
`convex/http.ts` serves the browser files with `serveAsset` and renders every other path with the
server build, through
[`@samebase/convex-hosting-tanstack-start`](../../packages/convex-hosting-tanstack-start). The
example has its own schema, so it needs its own Convex project.

## Kinds of pages

The demo data is a to-do list in `convex/todos.ts`.

- `/about`: a static file from the build. `vite.config.ts` has TanStack Start prerender this page
  only, into `dist/client/about/index.html`, and `serveAsset` serves it like any other file. As on
  Cloudflare, `/about` answers 307 to `/about/`, which answers the file. Its "Built at" time comes
  from a loader that ran in the build; links to the page reload the document, so the browser does
  not run the loader again.
- `/`: rendered per request, and needs no session. The first HTML response contains `todos.count`,
  the number of todos of all users, and the count stays live after React hydrates.
- `/todos`: rendered as the user. The first HTML response contains the user's todos from
  `todos.list`, and the form adds one with `todos.add`. The page sits behind the pathless layout in
  `src/routes/_authed.tsx`: without a session, the server redirects to `/signin`, and the browser
  does the same when the session ends.
- `/signin`: a button that signs in anonymously and opens `/todos`.
- The header on every page: the root route's loader queries `users.me`, so the first HTML response
  of a rendered page shows `Signed in as <id>` with a sign-out button, or a link to `/signin`. The
  build has no session, so on `/about` the header fills in after React hydrates.

## Sessions

The refresh token lives in an httpOnly cookie; browser code holds only the access token, which
expires after 60 seconds. For each page, `convex/http.ts` reads the cookies, refreshes the access
token when it expires within 10 seconds (the refresh rotates both cookies), renders the page with
`server.fetch(request, { context: { token } })`, and returns the page with the rotated cookies. The
root route's `beforeLoad` gives the token to the Convex HTTP client of the server render, so the
page's queries run as the user. In the browser, `ConvexAuthNextjsProvider` (it contains no Next.js
code) starts from the token of the server render and calls `POST /auth/signin`, `/auth/refresh`, and
`/auth/signout` in `convex/http.ts`. `expectAuth` makes the browser's Convex client wait for a token
before its first subscription, so a page rendered as the user gets the user's live answer, and it
never releases for a visitor without a session. Convex's AuthKit template decides `expectAuth` on
the server per request; TanStack creates the client before the page knows the session, so the root
route releases it when the provider reports none. `expectAuth` holds queries only before the first
authentication, so sign-out reloads the page.

The example signs in anonymously: each sign-in creates a user. Password or OAuth sign-in changes the
provider in `convex/convex.config.ts` and `convex/auth.ts`, the `signIn: [...]` list in
`convex/http.ts`, and the button on `/signin`. The other routes stay the same.

## Set up

From `examples/tanstack-ssr`, after `pnpm install` at the repository root:

1. `npx convex dev`. It writes `.env.local`, then its first push fails: `convex/http.ts` imports
   `dist/server/server.js` and `.convex-hosting/version.js`, which do not exist yet, and the
   deployment has no `AUTH_PRIVATE_KEY` and `AUTH_JWKS`.
2. In a second terminal, `pnpm run build` and `pnpm exec convex-hosting init`. The build prerenders
   `/about`, which creates the Convex client from `VITE_CONVEX_URL` in `.env.local`.
3. `npx @convex-dev/auth`. It generates an RS256 key pair, sets both variables on the deployment
   that `.env.local` names, and leaves the files in `convex/` as they are. Save a file in `convex/`
   so that `npx convex dev` pushes again.
4. `pnpm run deploy:dev`, then open the site URL, `VITE_CONVEX_SITE_URL` in `.env.local`.

Production needs its own key pair on the production deployment before the first `pnpm run deploy`.

## Commands

- `pnpm run dev`: Vite's dev server, with `npx convex dev` in another terminal. It renders the pages
  in Vite's own server without the session: `/`, `/about`, and `/signin` show, `/todos` moves to
  `/signin`, and sign-in works only on the deployed site, where `convex/http.ts` serves the `/auth`
  routes.
- `pnpm run build`: build the browser files into `dist/client` and the server into `dist/server`,
  and prerender `/about`.
- `pnpm run deploy:dev`: build, upload, and push to the development deployment.
- `pnpm run deploy`: build, upload, and push to production.

For everything else, see the [README](../../README.md).
