# TanStack Start SPA example

Live at [quick-fish-630.convex.site](https://quick-fish-630.convex.site), deployed from `main`.

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

From `examples/tanstack-spa`:

```sh
pnpm install
npx convex dev --skip-push        # creates your dev deployment and .env.local, no push
pnpm run deploy:dev               # builds, uploads, writes .convex-hosting/version.js, pushes
npx convex dev                    # then work as usual
```

The example commits `convex/_generated`, as Convex recommends, so a fresh clone can build:
`npx convex dev --skip-push` does not write it, and `npx convex codegen` bundles `convex/http.ts`,
so on a fresh clone it fails with the "Could not resolve" error below.

`convex/http.ts` imports `.convex-hosting/version.js`, which only `deploy:dev` writes. If
`.convex-hosting/` is deleted later, `npx convex dev` fails with a clear "Could not resolve" error,
and `pnpm run deploy:dev` fixes it. The site URL is `VITE_CONVEX_SITE_URL` in `.env.local`.

Local deployment (anonymous or `--local`): the backend must be running while `deploy:dev` uploads,
else the upload fails with `fetch failed`. Run `npx convex dev` first and keep it running, then run
`pnpm run deploy:dev` in a second terminal. `deploy:dev` pushes by itself, so the site works when it
ends. The running `npx convex dev` keeps its "Could not resolve" error until the next change under
`convex/`, then pushes as usual.

The build creates the Convex client from `VITE_CONVEX_URL` when it prerenders the shell, but sends
no query, so any URL builds.

## Commands

- `pnpm run dev`: Vite's dev server, with `npx convex dev` in another terminal.
- `pnpm run build`: build the browser files and the shell into `dist/client`.
- `pnpm run deploy:dev`: build, upload, and push to the development deployment.
- `pnpm run deploy`: build, upload, and push to production.

For everything else, see the [README](../../README.md).
