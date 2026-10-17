# Convex Hosting

Serves a web app from its own Convex deployment, at `https://<deployment>.convex.site`: the files of
a build, and the pages the app renders.

The serving code is Cloudflare's. The asset Worker behind
[Cloudflare Workers with static assets](https://developers.cloudflare.com/workers/static-assets/) is
copied from [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk) at a pinned commit
and runs inside a Convex HTTP action. So `_headers`, `_redirects`, `.assetsignore`, `html_handling`,
and `not_found_handling` mean what they mean on Cloudflare, and a request gets the response a Worker
sends. This repository's CI runs Cloudflare's own tests against it: its
[196 cases](https://github.com/samebase/convex-hosting/blob/main/packages/convex-hosting/src/component/conformance.test.ts)
for `html_handling` and path encoding, and its
[integration test](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting/src/workers-sdk/fixtures/workers-with-assets-only)
for a files-only site, unchanged, on a local Convex deployment.

An app that renders pages takes the place of the Worker script: an object with `fetch(request)` that
answers what no file answers. TanStack Start has
[an adapter](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start),
with streamed pages, server functions, server routes, request middleware, and cookie sessions. The
[TanStack Start example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
is deployed here and, from the same source, as a real Worker; CI keeps the two byte-identical but
for the files that name the host.

Use it when the backend is Convex and a second host for the frontend is one host too many. A Worker
has what Convex does not: the data center nearest the visitor, Node's built-in modules, an edge
cache, and WebSockets. The list, with numbers, is in
[What differs from a Worker](https://github.com/samebase/convex-hosting/blob/main/docs/workers.md).

## Use

Requires `convex` 1.46 or later.

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

`convex/http.ts` sends every method to `serveSite`, as every request reaches a Cloudflare Worker:

```ts
import { httpRouter } from "convex/server";
import { serveSite } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

const site = httpAction(serveSite(components.hosting, versionId));
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
  http.route({ pathPrefix: "/", method, handler: site });
}

export default http;
```

Deploy:

```sh
npx convex-hosting deploy --build "vite build" --dist dist --not-found-handling single-page-application
```

It builds, uploads `dist`, pushes the functions, and prints
`Deployed version <id> to https://<deployment>.convex.site.` Deploy production with this command,
never with a plain `npx convex deploy`: a plain push uploads no files, and the site answers 404
until the next `convex-hosting deploy`.

On a fresh clone, `npx convex dev` fails until the first deploy: `convex/http.ts` imports
`.convex-hosting/version.js`, which only a deploy writes, and the deploy's build needs the
deployment URL, which only `npx convex dev` writes to `.env.local`. So the first time:

```sh
npx convex dev --skip-push   # creates your dev deployment and .env.local, no push
npx convex-hosting deploy --dev --build "vite build" --dist dist --not-found-handling single-page-application
npx convex dev               # then work as usual
```

For pages rendered on the server, pass the app's server entry, the object with `fetch(request)`, as
the third argument of `serveSite`. The
[adapter](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start)
shows it for TanStack Start.

## Examples

- [tanstack-spa](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-spa): a
  single-page app, live at [quick-fish-630.convex.site](https://quick-fish-630.convex.site).
- [tanstack-ssr](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr): pages
  rendered per request, with cookie sessions, live at
  [gallant-llama-40.convex.site](https://gallant-llama-40.convex.site). Its
  [Worker twin](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr-workers)
  is live at
  [convex-hosting-tanstack-ssr-workers.pfp.workers.dev](https://convex-hosting-tanstack-ssr-workers.pfp.workers.dev).

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
- [Design](https://github.com/samebase/convex-hosting/blob/main/docs/design.md): why each piece is
  what it is.
- [Changelog](https://github.com/samebase/convex-hosting/blob/main/packages/convex-hosting/CHANGELOG.md).

## Status

Version 0.9, before 1.0: a minor release can change the API, and the changelog says what changed.
The author's apps run on it, among them [Scout](https://github.com/samebase/scout) and
[chessmerge.com](https://chessmerge.com).

## License

Apache-2.0, with the notices in
[NOTICE](https://github.com/samebase/convex-hosting/blob/main/NOTICE). Not affiliated with or
endorsed by Convex. To work on this repository, see
[CONTRIBUTING.md](https://github.com/samebase/convex-hosting/blob/main/CONTRIBUTING.md).
