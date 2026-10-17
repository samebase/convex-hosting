# Static site example

Live at [courteous-dalmatian-252.convex.site](https://courteous-dalmatian-252.convex.site), deployed
from `main`.

Cloudflare's own static-site template, what `npm create cloudflare` writes for "Static site"
(`hello-world-assets-only`): one `public/index.html`, no build, no script. `convex/http.ts` serves
it with `routeAll` and nothing else, and `public/` is byte-identical to
[`examples/hello-world-assets-only-workers`](../hello-world-assets-only-workers), the same template
deployed as a Cloudflare Worker. The page's text names `wrangler.jsonc` because it is the template's
file, unchanged.

## What it shows

- `GET /` answers `index.html` with an `ETag` and
  `Cache-Control: public, max-age=0, must-revalidate`; with `If-None-Match` it answers 304.
  `GET /index.html` answers 307 to `/`, as `html_handling` `auto-trailing-slash` does on Cloudflare.
- `HEAD /` answers the headers without the body.
- `POST /`, or any method but GET and HEAD on a file, answers 405.
- A path with no file answers 404 for every method, with `Cache-Control: no-store`: the site has no
  script, and `not_found_handling` is `none`.

```sh
curl -s -o /dev/null -w "%{http_code}\n" <site>/index.html   # 307
curl -s -o /dev/null -w "%{http_code}\n" -X POST <site>/     # 405
```

## Set up

From `examples/hello-world-assets-only`:

In one terminal, kept running:

```sh
pnpm install
npx convex dev                    # creates your dev deployment and .env.local; its first push fails
```

In another:

```sh
pnpm run deploy:dev               # uploads public/, writes .convex-hosting/version.js, pushes
```

The example commits `convex/_generated`, as Convex recommends, so a fresh clone typechecks:
`npx convex codegen` bundles `convex/http.ts`, which imports `.convex-hosting/version.js`, so on a
fresh clone it fails with "Could not resolve" until the first `deploy:dev`.

Local deployment (anonymous or `--local`): the backend runs inside `npx convex dev`, so the first
terminal must stay open while `deploy:dev` uploads, else the upload fails with `fetch failed`.

## Commands

- `pnpm run deploy:dev`: upload `public/` and push to the development deployment.
- `pnpm run deploy`: upload `public/` and push to production.

For everything else, see the [README](../../README.md).
