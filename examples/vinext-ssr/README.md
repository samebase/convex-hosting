# vinext SSR example

[vinext](https://github.com/cloudflare/vinext)'s App Router rendered inside a Convex HTTP action,
with [Convex Auth](https://github.com/get-convex/convex-auth) sessions in httpOnly cookies. It is
the app of the [TanStack Start example](../tanstack-ssr) on a second framework. `convex/http.ts`
serves the browser files with `serveSite` and renders every other request with vinext's server
build. The example has its own schema, so it needs its own Convex project.

## Kinds of pages

The demo data is the to-do list of the TanStack example, in `convex/todos.ts`.

- `/`: public. The Server Component preloads the latest twenty todos of all users with their authors
  from `todos.latest`, so the first HTML response contains them, and the list stays live after React
  hydrates.
- `/todos`: rendered as the user. Without a session, the page calls `redirect("/signin")` on the
  server. The first HTML response contains the user's todos from `todos.list`, the form adds one
  with the `todos.add` mutation, and a checkbox toggles `todos.toggle`, both from the browser.
- `/signin`: a button that signs in anonymously and loads `/todos` as a document.
- `/about`: text, rendered for each request like the other pages.
- The header on every page: the root layout preloads `users.me`, so the first HTML response shows
  `Signed in as <name>` with a sign-out button, or a link to `/signin`. Sign-out reloads the page,
  so the server renders it without the session, and `/todos` moves to `/signin`.

## Sessions

Convex Auth's Next.js integration owns the session, unchanged: vinext provides `next/headers` and
`next/server`, so `@convex-dev/auth/nextjs/server` runs inside the HTTP action.

- `auth.ts` calls `setupConvexAuthNextjs` once.
- `proxy.ts` is Convex Auth's proxy. Before each page renders, it refreshes the access token when it
  expires within 10 seconds, rotates both cookies on the response, and gives the page the fresh
  token through `cookies()`.
- The root layout wraps the document in `ConvexAuthNextjsServerProvider`, which gives the browser's
  Convex client the access token of the render. The refresh token stays in its httpOnly cookie.
- Pages read the token with `convexAuthNextjsAccessToken()` and pass it to `preloadQuery`, so their
  queries run as the user. `/todos` checks the session with `isAuthenticatedNextjs()`.
- `convex/http.ts` registers Convex Auth's `/auth/signin`, `/auth/refresh`, and `/auth/signout`
  routes, which the browser's provider calls. It has no other session code.

## The prebundle

vinext emits its server as a Cloudflare Worker, `dist/server/index.js`, an object with
`fetch(request, env, ctx)`. `vite.config.ts` has the Cloudflare Vite plugin for that output only;
nothing deploys to Workers. Convex cannot run that entry as it is: it imports Node and Workers
modules that the Convex CLI cannot bundle, it reads `import.meta`, which the Convex runtime does not
support, and it calls `queueMicrotask`, which the runtime lacks. `scripts/bundle-server.ts` runs
after `vite build` and writes one module, `dist/server/convex.js`, with esbuild: stubs for the
modules (each is used only by a feature that needs a Node or Workers host), constants for
`import.meta.url` and `import.meta.filename`, and a `queueMicrotask` polyfill.
`convex/server-build.d.ts` declares the module's type.

## Where code goes

vinext is the renderer here, and Convex is the backend. `convex/http.ts` is the server entry, what
the Worker is on Cloudflare: it serves the files, registers the `/auth` routes, and calls
`fetch(request, {}, { waitUntil })` for the rest. It waits for the work that vinext hands to
`waitUntil` before it answers.

- Pages, layouts, Server Components, and `proxy.ts` live in the app.
- Data and endpoints live in `convex/`. A Server Component reads data with `preloadQuery`, and a
  Client Component keeps it live with `usePreloadedQuery`. Writes are Convex mutations from the
  browser.
- A Server Action or a route handler runs inside the HTTP action and calls Convex over HTTP, like a
  Server Component. `convex/http.ts` sends `POST` requests to vinext for Server Actions.

## Differences from the TanStack example

- `convex/http.ts` also routes `POST` to the renderer, because Server Actions post to the page's
  path. Other methods need a route of their own.
- There is no context argument. vinext's `fetch` takes the Worker's `env` and `ctx`, and pages read
  the session from the cookies themselves, so `http.ts` has no session lines.
- No page is prerendered yet. vinext writes prerendered routes to `dist/server/prerendered-routes`,
  not to `dist/client`, so `serveSite` has no file to serve, and `/about` renders for each request.
- The browser's Convex client does not use `expectAuth`. Five reloads of `/` and of `/todos` while
  signed in showed no other header or list than the server HTML.
- Pages are not streamed: `render` reads the whole body before it answers, because vinext starts
  `after()` callbacks only once the body has been read.

## Set up

From `examples/vinext-ssr`, after `pnpm install` at the repository root:

1. `npx convex dev`. It writes `.env.local`, then its first push fails: `convex/http.ts` imports
   `dist/server/convex.js` and `.convex-hosting/version.js`, which do not exist yet, and the
   deployment has no `AUTH_PRIVATE_KEY` and `AUTH_JWKS`.
2. In a second terminal, `pnpm run build` and `pnpm exec convex-hosting init`. The build reads
   `VITE_CONVEX_URL` from `.env.local`.
3. `npx @convex-dev/auth`. It generates an RS256 key pair, sets both variables on the deployment
   that `.env.local` names, and leaves the files in `convex/` as they are. Save a file in `convex/`
   so that `npx convex dev` pushes again.
4. `pnpm run deploy:dev`, then open the site URL, `VITE_CONVEX_SITE_URL` in `.env.local`.

Production needs its own key pair on the production deployment before the first `pnpm run deploy`.

## Commands

- `pnpm run build`: build the browser files into `dist/client` and the server into `dist/server`,
  then the prebundle into `dist/server/convex.js`.
- `pnpm run deploy:dev`: build, upload, and push to the development deployment.
- `pnpm run deploy`: build, upload, and push to production.

For everything else, see the [README](../../README.md).
