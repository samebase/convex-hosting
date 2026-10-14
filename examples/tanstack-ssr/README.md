# TanStack Start SSR example

TanStack Start pages rendered inside a Convex HTTP action, with
[Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies.
`convex/http.ts` serves the browser files with `serveAsset` and renders every other path with the
server build, through
[`@samebase/convex-hosting-tanstack-start`](../../packages/convex-hosting-tanstack-start). The
example has its own schema, so it needs its own Convex project.

## Pages

- `/`: the first HTML response already contains a count from a Convex query, and the count stays
  live after React hydrates. It needs no session.
- `/me`: the result of `users.me` for the session of the request, in the first HTML response:
  `Signed in as <id> since <time>` with a sign-out button, or `Not signed in` with a sign-in button.
  The query result decides what shows; there are no redirects.

## Sessions

The refresh token lives in an httpOnly cookie; browser code holds only the access token, which
expires after 60 seconds. For each page, `convex/http.ts` reads the cookies, refreshes the access
token when it expires within 10 seconds (the refresh rotates both cookies), renders the page with
`server.fetch(request, { context: { token } })`, and returns the page with the rotated cookies. The
root route's `beforeLoad` gives the token to the Convex HTTP client of the server render, so the
page's queries run as the user. In the browser, `ConvexAuthNextjsProvider` (it contains no Next.js
code) starts from the token of the server render and calls `POST /auth/signin`, `/auth/refresh`, and
`/auth/signout` in `convex/http.ts`. The browser's Convex client holds its queries until the
provider knows the session, so the page never shows the signed-out answer before the token arrives.

The example signs in anonymously: each sign-in creates a user. Password or OAuth sign-in changes the
provider in `convex/convex.config.ts` and `convex/auth.ts`, the `signIn: [...]` list in
`convex/http.ts`, and the button on `/me`. The page route stays the same.

## Set up

From `examples/tanstack-ssr`, after `pnpm install` at the repository root:

1. `pnpm run build` and `pnpm exec convex-hosting init`. `convex/http.ts` imports
   `dist/server/server.js` and `.convex-hosting/version.js`, so `npx convex dev` cannot bundle it
   before both exist.
2. `npx convex dev`. Its first push fails: the deployment has no `AUTH_PRIVATE_KEY` and `AUTH_JWKS`
   yet.
3. In a second terminal, `npx @convex-dev/auth`. It generates an RS256 key pair, sets both variables
   on the deployment that `.env.local` names, and leaves the files in `convex/` as they are. Save a
   file in `convex/` so that `npx convex dev` pushes again.
4. `pnpm run deploy:dev`, then open the site URL, `VITE_CONVEX_SITE_URL` in `.env.local`.

Production needs its own key pair on the production deployment before the first `pnpm run deploy`.

## Commands

- `pnpm run dev`: Vite's dev server, with `npx convex dev` in another terminal. It renders the pages
  in Vite's own server, without the session; sign-in works only on the deployed site, where
  `convex/http.ts` serves the `/auth` routes.
- `pnpm run build`: build the browser files into `dist/client` and the server into `dist/server`.
- `pnpm run deploy:dev`: build, upload, and push to the development deployment.
- `pnpm run deploy`: build, upload, and push to production.

For everything else, see the [README](../../README.md).
