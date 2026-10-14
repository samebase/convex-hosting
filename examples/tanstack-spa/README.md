# TanStack Start SPA example

Live at LIVE_URL, deployed from `main`.

TanStack Start in SPA mode, served from Convex by `serveSite` with
`--not-found-handling single-page-application`. It has no server entry, no adapter, and no sign-in.
The example has its own schema, so it needs its own Convex project.

## What it shows

- The build prerenders one page, the shell, into `dist/client/index.html`, the file that the
  single-page-application fallback serves. The shell holds the head and the scripts; the header and
  the route render in the browser, because the same shell answers every path.
- `/`: a counter from `convex/counter.ts` that stays live, and a button that adds a click.
- `/about`: no file answers it. A browser that opens it gets the shell, and the router renders the
  page.

  ```sh
  curl -s -o /dev/null -w "%{http_code}" -H "Sec-Fetch-Mode: navigate" <site>/about
  ```

  answers 200 with the shell. Without the header, the same path answers 404 with
  `Cache-Control: no-store`: the fallback applies to navigations only, as on Cloudflare.

- `public/_headers` caches the hashed files under `/assets/` for a year, and `public/_redirects`
  sends `/home` to `/`: `curl -I <site>/home` answers 301 with `Location: /`.

## Set up

From `examples/tanstack-spa`, after `pnpm install` at the repository root:

1. `pnpm exec convex-hosting init`, so that `npx convex dev` can bundle `convex/http.ts`.
2. `npx convex dev`. It writes `.env.local` and pushes the functions.
3. In a second terminal, `pnpm run deploy:dev`, then open the site URL, `VITE_CONVEX_SITE_URL` in
   `.env.local`.

The build creates the Convex client from `VITE_CONVEX_URL` when it prerenders the shell, but sends
no query, so any URL builds.

## Commands

- `pnpm run dev`: Vite's dev server, with `npx convex dev` in another terminal.
- `pnpm run build`: build the browser files and the shell into `dist/client`.
- `pnpm run deploy:dev`: build, upload, and push to the development deployment.
- `pnpm run deploy`: build, upload, and push to production.

For everything else, see the [README](../../README.md).
