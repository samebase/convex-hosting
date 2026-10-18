# Serving

## `_headers`, `_redirects`, and `.assetsignore`

Put them at the root of `--dist`, as for Cloudflare:
[`_headers`](https://developers.cloudflare.com/workers/static-assets/headers/),
[`_redirects`](https://developers.cloudflare.com/workers/static-assets/redirects/), and
[`.assetsignore`](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets).
For a Vite app, put them in `public/`, which Vite copies into `dist/`. They are not served. A link
to a file in `--dist` counts as the file it points to, as in Wrangler, also when it points outside
the folder; a link to a folder is not walked, as Wrangler does not walk it, and a link to nothing is
skipped, both with a message. `.assetsignore` excludes what a link should not publish.

Every asset answers with an `ETag` and, unless the request carries `Authorization` or `Range`,
`Cache-Control: public, max-age=0, must-revalidate`. To cache hashed files for a year, add a
`_headers` rule:

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

The `*.convex.site` front drops `immutable` from this header and keeps the `max-age` (seen on `.js`
and `.css` files, on a cache miss and a hit): the year applies, and a browser may still revalidate
the file when the page reloads. A local deployment, which has no front, sends the header as written.

## Routing

`routeAll(http, component, versionId, worker?)` routes the site's HTTP action for every method at
every path, and returns it. The action answers with the file that matches, else with what `worker`
answers (see [Server-rendered pages](#server-rendered-pages)), else 404. Another method than GET or
HEAD on a path that has a file answers 405, as on Cloudflare; on any other path it goes to `worker`,
else 404. `worker` is the Worker script, an object with `fetch(request)`: the code that runs on a
miss. Everything it returns gets `Cache-Control: no-store`, and so does a 404, because the
`*.convex.site` front caches paths with an extension. The front keeps `no-store` for a path without
an extension and replaces it with a four-hour browser `max-age` for a path with one, so a browser
that asks for a script before its upload ended keeps the 404; the deploy order prevents that case,
because no page refers to a file that is not uploaded yet. When the version does not exist or is
still uploading, it answers 404 naming the version. At the first request for a new version, it marks
the version live.

As on Cloudflare, the presence of code decides where `not_found_handling` (the single-page fallback
or the 404 page) applies:

- Without `worker`, the site is files only, like a Worker without a script: `not_found_handling`
  applies to every request. `curl`, uptime monitors, and link-preview bots get what a browser gets.
- With `worker`, your code is the Worker: `not_found_handling` applies to navigation requests
  (`Sec-Fetch-Mode: navigate`) only, and other requests that match no file reach your code. Browsers
  send that header whenever they open a page. `curl`, `fetch` in scripts and tests, uptime monitors,
  and link-preview bots do not. To test a deep link as a browser opens it, send the header:
  `curl -H "Sec-Fetch-Mode: navigate"`, or `node:http` in Node, whose `fetch` refuses to set it.

On a files-only single-page app, a missing hashed file such as `/assets/old.js` gets the shell, with
200 and `text/html`, as on Cloudflare. A `_headers` rule for its path applies to it too, so with the
one-year rule above a browser keeps that HTML for a year; without a rule, the deployment's
Cloudflare front gives a path with an extension a four-hour browser `max-age`. Hashed names do not
come back.

One difference from Cloudflare follows from Convex's router: an exact route in `convex/http.ts` wins
over an asset at the same path. The other differences are in
[What differs from a Worker](./workers.md).

## Server-rendered pages

`routeAll` takes a fourth argument, `worker`, the object with `fetch(request)` that the app's server
entry exports, and calls it when no file matches. `convex/http.ts` imports the server build
directly, such as `../dist/server/server.js` for TanStack Start, so `npx convex dev` bundles it only
after a build: on a fresh clone, the first `deploy --dev` builds before the first push (see
[Use](../README.md#use)).

[`@samebase/convex-hosting-tanstack-start`](../packages/convex-hosting-tanstack-start) runs TanStack
Start's own server handler in that `fetch`. Pages stream: the document goes out as it renders, and
each Suspense boundary or deferred loader value follows in its own chunk. Server functions, server
routes, request middleware, and Convex Auth cookie sessions run as they do on a Worker. The
[TanStack Start example](../examples/tanstack-ssr), live at
[gallant-llama-40.convex.site](https://gallant-llama-40.convex.site), has a page for each:
`/stream`, `/server`, `/todos`.

A page prerendered at build time is a file of the build, and the file rules decide where it answers:

- A page prerendered to `/x/index.html` answers at `/x/` under the default `auto-trailing-slash`,
  and `/x` redirects there with 307. `--html-handling drop-trailing-slash` serves it at `/x`.
- Under every `--html-handling` but `none`, a file `/index.html` answers `/`, so a single-page shell
  built to `/index.html` replaces the rendered home page. With a server entry, do not build one.
- Keep `--not-found-handling` at its default, `none`. With a server entry, the other two values
  answer a navigation that matches no file with the shell or the 404 page, before the server entry
  sees it.
