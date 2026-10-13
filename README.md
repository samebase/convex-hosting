# Convex Hosting

Host a web app on Convex, next to its backend: the files of a build and, when the app renders pages,
those pages. The site is at `https://<deployment>.convex.site`.

It works like
[Cloudflare Workers with static assets](https://developers.cloudflare.com/workers/static-assets/):
the same `_headers`, `_redirects`, and `.assetsignore` files, the same `html_handling` and
`not_found_handling` options, and the same responses, computed by Cloudflare's own asset-serving
code.

## Install

```sh
npm install @samebase/convex-hosting
```

`convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

const app = defineApp();
app.use(hosting);

export default app;
```

`convex/http.ts` has one `GET` route for the site. Convex answers `HEAD` through it.

```ts
import { httpRouter } from "convex/server";
import { serveAsset } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const asset = await serveAsset(ctx, components.hosting, request, versionId);
    if (asset) return asset;
    // A static site: 404. A server-rendered site: render the page here, also with `no-store`.
    // The deployment's Cloudflare front caches answers on static-looking paths.
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }),
});

export default http;
```

`convex-hosting` keeps its state in `.convex-hosting/` at the project root, next to `convex/`, like
Wrangler's `.wrangler/`. Every deploy writes the version to `.convex-hosting/version.js`. The folder
has its own `.gitignore`, so git ignores it. One committed declaration,
`convex/convex-hosting.d.ts`, types the module before the first deploy:

```ts
declare module "*/.convex-hosting/version.js" {
  export const versionId: string;
}
```

A `tsconfig.json` that typechecks `convex/http.ts` through `convex/_generated/api`, such as the
frontend's, also needs this file in its `include`.

## Deploy

```sh
npx convex-hosting deploy --build "vite build" --dist dist --not-found-handling single-page-application
```

The build command runs in the project directory. Do not change directory in it.

`deploy` runs `npx convex deploy` with your build and the upload of `--dist` as its `--cmd`. The
pushed code names the version it was built with, so the push switches the site, and the command
ends. The first request that the new code serves marks its version live, which deletes the versions
that were live before it. A version that never becomes live, from a deploy that failed, is deleted
when it is a day old, with the stored files that no version uses.

`deploy` goes to production. `--preview <name>` sends it to that preview (with a login or a
project's preview deploy key; always pass the name with that key), and `--dev` to the development
deployment (see [Development](#development)). A deploy key in `CONVEX_DEPLOY_KEY` or
`CONVEX_DEPLOYMENT_TOKEN` (from the environment or `.env.local`) selects its own deployment instead,
and so does `CONVEX_SELF_HOSTED_URL` for a self-hosted deployment.

The first deploy to a deployment pushes the component, then uploads the files. Until that upload
ends, the site answers 404. Run the first deploy of a deployment once, alone.

Two deploys that overlap both complete, and the last push wins.

## Development

The inner loop is your framework's dev server, such as Vite's, which serves the frontend locally
with hot reload against the development deployment's URL from `.env.local`, plus `npx convex dev`,
which pushes your function changes.

When the development deployment should serve the current build, run the one-shot command:

```sh
npx convex-hosting deploy --dev --build "vite build" --dist dist --not-found-handling single-page-application
```

`deploy --dev` goes to the development deployment of this checkout, the one in `.env.local`. It runs
the build itself, uploads `--dist`, writes `.convex-hosting/version.js`, and pushes with
`npx convex run --push`, which works whether or not `npx convex dev` runs. The build runs with your
environment, so the framework reads the deployment's URL from `.env.local` (Vite reads
`VITE_CONVEX_URL`). There is no watch mode: a build, an upload, and a push per change is not an
inner loop, and Cloudflare's own tooling works the same way, with a local dev server and a push on
demand. A fresh clone runs `deploy --dev` once; after that, the version file exists and
`npx convex dev` bundles as usual.

Two cases are transient:

- A server-rendered app imports `dist/server` in `convex/http.ts`, so a running `npx convex dev`
  pushes after the build, before `deploy --dev` writes the new version. Until `deploy --dev` ends,
  the new pages refer to files that answer 404.
- A production deploy writes production's version to the version file, and a running
  `npx convex dev` pushes it to the development deployment, where that version does not exist, until
  the next `deploy --dev`. Run production deploys in CI or in a separate checkout.

## Options

| Option                         | Values                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `--dev`                        | The development deployment of this checkout, instead of production                     |
| `--preview <name>`             | The preview deployment with this name, instead of production                           |
| `--html-handling <value>`      | `auto-trailing-slash` (default), `force-trailing-slash`, `drop-trailing-slash`, `none` |
| `--not-found-handling <value>` | `none` (default), `single-page-application`, `404-page`                                |
| `--component <name>`           | The component instance, `hosting` by default                                           |

The two handling options work as
[Cloudflare documents them](https://developers.cloudflare.com/workers/static-assets/routing/).

Each file of `--dist` must be 25 MiB or smaller, and the CLI names a file that is larger. This is
Cloudflare's limit per asset, and the HTTP action that serves a file cannot answer more than
Convex's 100 MiB response limit anyway.

## `_headers`, `_redirects`, and `.assetsignore`

Put them at the root of `--dist`, as for Cloudflare:
[`_headers`](https://developers.cloudflare.com/workers/static-assets/headers/),
[`_redirects`](https://developers.cloudflare.com/workers/static-assets/redirects/), and
[`.assetsignore`](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets).
They are not served.

Every asset has `Cache-Control: public, max-age=0, must-revalidate` and an `ETag`. To cache hashed
files for a year, add a `_headers` rule:

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

## Routing

`serveAsset` returns the asset's response, or `null` when no asset matches, so your route continues.
When the version does not exist or is still uploading, it returns a 404 response that names the
version. At the first request for a new version, it marks the version live.

`not_found_handling` applies to navigation requests (`Sec-Fetch-Mode: navigate`) only, as on
Cloudflare when a Worker runs: other requests that match no file reach your code. Two differences
from Cloudflare follow from Convex's router:

- An exact route in `convex/http.ts` wins over an asset at the same path.
- On a static site, a request that is not a navigation and matches no file (`curl /missing`) answers
  404, not the single-page fallback.

## Open tabs after a deploy

A page opened before a deploy keeps asking for its hashed files, which now answer 404, as on
Cloudflare. To reload open tabs on a new version, add a query that returns the bundled version:

```ts
// convex/siteVersion.ts
import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

export const get = query({ args: {}, returns: v.string(), handler: () => versionId });
```

and reload when its value changes after the first one:

```tsx
import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "../convex/_generated/api";

export function useReloadOnNewVersion() {
  const versionId = useQuery(api.siteVersion.get);
  const first = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (versionId === undefined) return;
    first.current ??= versionId;
    if (versionId !== first.current) location.reload();
  }, [versionId]);
}
```

## Server-rendered pages

[`@samebase/convex-hosting-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start)
renders TanStack Start pages in the same route, after `serveAsset`. See the
[TanStack Start example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr).

## License

Apache-2.0, with the notices in
[NOTICE](https://github.com/samebase/convex-hosting/blob/main/NOTICE). Not affiliated with or
endorsed by Convex. To work on this repository, see
[CONTRIBUTING.md](https://github.com/samebase/convex-hosting/blob/main/CONTRIBUTING.md).
