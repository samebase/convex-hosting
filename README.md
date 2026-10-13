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
import { versionId } from "./hostingVersion.generated.js";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const asset = await serveAsset(ctx, components.hosting, request, versionId);
    if (asset) return asset;
    // A static site: 404. A server-rendered site: render the page here.
    return new Response(null, { status: 404 });
  }),
});

export default http;
```

`convex-hosting` writes `convex/hostingVersion.generated.ts` on every upload and deploy. Commit it.
The committed value acts only when `npx convex dev` pushes a checkout that nobody has uploaded from:
the site then answers 404 naming that version until the next upload. Every upload rewrites the file,
so let your formatter and linter ignore `**/*.generated.ts`.

## Deploy

```sh
npx convex-hosting deploy --build "vite build" --dist dist --not-found-handling single-page-application
```

`deploy` runs `npx convex deploy` with your build and the upload of `--dist` as its `--cmd`. The
pushed code names the version it was built with, so the push switches the site. After the push,
`deploy` deletes the earlier versions and their files.

The deployment is the one that `npx convex deploy` selects: the deployment of `CONVEX_DEPLOY_KEY`
(from the environment or `.env.local`), the preview named by `--preview-name` (with a login or a
project's preview deploy key), or else production.

The first deploy to a deployment pushes the component, then uploads the files. Until that upload
ends, the site answers 404.

Two deploys at once: the second one stops with
`A deploy of version <id> is in progress: it refreshed the lock <n> seconds ago.` Try again when the
first one ends. A deploy that stopped frees its lock 2 minutes after its last refresh. There is no
cancel command.

## Development deployment

With `npx convex dev` running, build and upload:

```sh
vite build && npx convex-hosting upload --dist dist --not-found-handling single-page-application
```

`upload` writes `convex/hostingVersion.generated.ts`, and `npx convex dev` pushes it within seconds.
Until then, the development site answers 404.

On a new project, before `npx convex dev` has pushed the component, `upload` writes the version file
and stops. `npx convex dev` then pushes the component; run `upload` again.

Two cases are transient:

- A server-rendered app imports `dist/server` in `convex/http.ts`, so `npx convex dev` pushes after
  the build, before `upload` writes the new version. Until the upload ends, the new pages refer to
  files that answer 404.
- A production deploy writes production's version to the version file, and `npx convex dev` pushes
  it to the development deployment, where that version does not exist, until the next `upload`. Run
  production deploys in CI or in a separate checkout.

## Options

| Option                         | Values                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `--html-handling <value>`      | `auto-trailing-slash` (default), `force-trailing-slash`, `drop-trailing-slash`, `none` |
| `--not-found-handling <value>` | `none` (default), `single-page-application`, `404-page`                                |
| `--component <name>`           | The component instance, `hosting` by default                                           |
| `--preview-name <name>`        | The preview deployment                                                                 |

The two handling options work as
[Cloudflare documents them](https://developers.cloudflare.com/workers/static-assets/routing/).

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
version.

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
import { versionId } from "./hostingVersion.generated.js";

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
