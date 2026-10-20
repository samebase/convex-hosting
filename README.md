# Convex Hosting

[![Convex Component](https://www.convex.dev/components/badge/samebase/convex-hosting)](https://www.convex.dev/components/samebase/convex-hosting)

A [Convex component](https://www.convex.dev/components/samebase/convex-hosting) that serves a web
app's built files and server-rendered pages from the deployment that runs its backend, at
`https://<deployment>.convex.site`.

Use it when the backend is on Convex and the frontend should be served from the same deployment,
including a [TanStack Start](https://tanstack.com/start) app with server-side rendering.

## Quick start

Requires Node 22 or later and `convex` 1.46 or later.

```sh
npm install @samebase/convex-hosting
```

`convex/convex.config.ts` mounts the component:

```ts
import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

const app = defineApp();
app.use(hosting);

export default app;
```

`convex/http.ts` registers the site, every method at every path, as every request reaches a
Cloudflare Worker:

```ts
import { httpRouter } from "convex/server";
import { routeAll } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

routeAll(http, components.hosting, versionId);

export default http;
```

Deploy:

```sh
npx convex-hosting deploy --build "vite build" --dist dist
```

It builds, uploads `dist`, pushes the functions, and prints
`Deployed version <id> to https://<deployment>.convex.site.` A site with no build omits `--build`; a
single-page app adds `--not-found-handling single-page-application`. Deploy production with this
command, never with a plain `npx convex deploy`: a plain push names the version of this checkout's
last deploy, often another deployment's, and the site answers 404 until the next
`convex-hosting deploy`.

On a fresh clone, the first push of `npx convex dev` fails: `convex/http.ts` imports
`.convex-hosting/version.js`, which only a deploy writes. `npx convex dev` keeps running after that
error, so the first run is two terminals, for a cloud, local, or anonymous deployment alike:

```sh
npx convex dev   # creates your dev deployment and .env.local; keep it running
```

```sh
npx convex-hosting deploy --dev --build "vite build" --dist dist
```

The deploy writes the version file and pushes; the watcher in the first terminal shows its error
until the next change under `convex/`, and works as usual from then on.

## Server-rendered pages

An app that renders pages passes its server entry as the fourth argument of `routeAll`. The entry
takes the place of a Worker script: an object with `fetch(request)` that answers what no file
answers. TanStack Start has
[an adapter](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start),
with streamed pages, server functions, server routes, request middleware, and cookie sessions.

## Examples

- [hello-world-assets-only](https://github.com/samebase/convex-hosting/tree/main/examples/hello-world-assets-only):
  Cloudflare's static-site template, one `index.html` and no build, deployed with
  `convex-hosting deploy --dist public`, live at
  [courteous-dalmatian-252.convex.site](https://courteous-dalmatian-252.convex.site). Its
  [Worker twin](https://github.com/samebase/convex-hosting/tree/main/examples/hello-world-assets-only-workers)
  is the template unchanged, live at
  [convex-hosting-hello-world-assets-only.pfp.workers.dev](https://convex-hosting-hello-world-assets-only.pfp.workers.dev).
- [tanstack-spa](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-spa): a
  single-page app, live at [quick-fish-630.convex.site](https://quick-fish-630.convex.site).
- [tanstack-ssr](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr): pages
  rendered per request, with cookie sessions, live at
  [gallant-llama-40.convex.site](https://gallant-llama-40.convex.site). Its
  [Worker twin](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr-workers),
  live at
  [convex-hosting-tanstack-ssr-workers.pfp.workers.dev](https://convex-hosting-tanstack-ssr-workers.pfp.workers.dev),
  is the same source deployed as a real Worker; CI keeps the difference between the two to a
  [committed patch](https://github.com/samebase/convex-hosting/blob/main/examples/tanstack-ssr-workers.patch).

## Documentation

- [Deploy](https://github.com/samebase/convex-hosting/blob/main/docs/deploy.md): what `deploy` does,
  previews, deploy keys, CI, and the options.
- [Development](https://github.com/samebase/convex-hosting/blob/main/docs/development.md): the inner
  loop, `deploy --dev`, and reloading open tabs after a deploy.
- [Serving](https://github.com/samebase/convex-hosting/blob/main/docs/serving.md): `_headers`,
  `_redirects`, `.assetsignore`, caching, routing, and server-rendered pages.
- [Your own domain](https://github.com/samebase/convex-hosting/blob/main/docs/domains.md).
- [What differs from a Worker](https://github.com/samebase/convex-hosting/blob/main/docs/workers.md),
  and the same app deployed as one.
- [From static-hosting](https://github.com/samebase/convex-hosting/blob/main/docs/from-static-hosting.md):
  what differs from Convex's static-hosting component, and how to move an app.
- [Design](https://github.com/samebase/convex-hosting/blob/main/docs/design.md): why each piece is
  what it is.
- [Changelog](https://github.com/samebase/convex-hosting/blob/main/packages/convex-hosting/CHANGELOG.md).

## Compared with Cloudflare Workers

The files follow
[Cloudflare Workers rules](https://developers.cloudflare.com/workers/static-assets/). The serving
code is Cloudflare's asset Worker, copied from
[cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk) at a pinned commit and run
inside a Convex HTTP action, so `_headers`, `_redirects`, `.assetsignore`, `html_handling`, and
`not_found_handling` mean what they mean on Cloudflare.

This repository's CI runs Cloudflare's own tests against it: its
[196 cases](https://github.com/samebase/convex-hosting/blob/main/packages/convex-hosting/src/component/conformance.test.ts)
for `html_handling` and path encoding, and its
[integration test](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting/src/workers-sdk/fixtures/workers-with-assets-only)
for a files-only site, with its imports pointed at this package, on a local Convex deployment.

A Worker has what Convex does not: the data center nearest the visitor, Node's built-in modules, an
edge cache, and WebSockets.
[What differs from a Worker](https://github.com/samebase/convex-hosting/blob/main/docs/workers.md)
lists each difference, with numbers.

## Compared with static-hosting

Convex's [static-hosting](https://github.com/convex/static-hosting) component serves the files of a
build. This package started from it and exists for frameworks that render pages on the server, which
needed a different serving model: Cloudflare's rules for the files, and a deploy that switches code
and files together.
[From static-hosting](https://github.com/samebase/convex-hosting/blob/main/docs/from-static-hosting.md)
lists what differs and how to move an app.

## How a deploy switches the site

On Cloudflare, `wrangler deploy` uploads the files and the Worker code as one version, so the switch
is atomic. Here two systems hold the two halves: the component's storage holds the files, and
`npx convex deploy` pushes the code. `deploy` binds them the same way. It uploads the files as a new
version, writes that version's id to `.convex-hosting/version.js`, and then pushes the code, which
imports the file and asks the component for exactly that version. The push is the switch: no pointer
moves in a second step, so there is no moment when new code serves old files, and no page refers to
a file that is not uploaded yet. The first request the new code serves marks its version live and
deletes the versions that were live before it. A version whose push never came is deleted at a later
switch, once it is a day old; nothing is deleted by the clock alone. The one rule: run one deploy at
a time per deployment. The
[design](https://github.com/samebase/convex-hosting/blob/main/docs/design.md#orderings-and-timing)
works through every interleaving.

## Status

Before 1.0: a minor release can change the API, and the changelog says what changed. The author's
apps run on it, among them [Scout](https://github.com/samebase/scout) and
[chessmerge.com](https://chessmerge.com).

## License

Apache-2.0, with the notices in
[NOTICE](https://github.com/samebase/convex-hosting/blob/main/NOTICE). Not affiliated with or
endorsed by Convex. To work on this repository, see
[CONTRIBUTING.md](https://github.com/samebase/convex-hosting/blob/main/CONTRIBUTING.md).
