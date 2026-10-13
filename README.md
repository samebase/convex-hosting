# Convex Hosting

[![npm version](https://badge.fury.io/js/@samebase%2Fconvex-hosting.svg)](https://badge.fury.io/js/@samebase/convex-hosting)

A Convex component that hosts a web app directly on Convex: no separate hosting provider, no DNS to
wire up, no second deploy target. Run one command and your frontend is live at
`https://<deployment>.convex.site` alongside your backend. For server-rendered TanStack Start pages,
add
[`@samebase/convex-hosting-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start).

This is Samebase's fork of [get-convex/static-hosting](https://github.com/get-convex/static-hosting)
(Apache-2.0, see [NOTICE](https://github.com/samebase/convex-hosting/blob/main/NOTICE)). It is not
affiliated with or endorsed by Convex.

## Features

- **One-command deploy:** build, upload the files, push the backend, make the new version live, and
  verify it.
- **Cloudflare's routing rules:** requests go through the code of Cloudflare's Workers Static Assets
  handler, so `html_handling`, `not_found_handling`, `_headers`, `_redirects`, and `.assetsignore`
  work as on Cloudflare.
- **Caching:** every file gets an ETag and 304 answers; the paths that you select as immutable get a
  one-year cache.
- **One live version:** a deploy uploads a new version and then switches one pointer. As on
  Cloudflare Workers, the files of the previous version are gone after a deploy (see
  [Reload on a new version](#reload-on-a-new-version)).
- **Authenticated uploads:** uploads go through the Convex CLI's authenticated session; there's no
  public upload endpoint.
- **Automatic cleanup:** an hourly job deletes a replaced version at its next run, a version that
  never went live after a later backend push, and an unfinished upload after a day.

## Quick Start

Follow the three [setup steps](#setup), then run:

```bash
npm run deploy
```

Your app is live at `https://<deployment>.convex.site`.

## Setup

### 1. Install

```bash
npm install @samebase/convex-hosting
```

### 2. Register the component

`convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

// Your own HTTP endpoints (convex/http.ts) are served under /api so the
// static site can own the root.
const app = defineApp({ httpPrefix: "/api" });
app.use(hosting, { httpPrefix: "/" });

export default app;
```

The component owns `/`, while your app's `convex/http.ts` routes move under `/api/...`.

If existing callbacks or auth routes must stay at the root, use
[app-owned root routing](#keep-existing-http-routes-at-the-root). To host the site under a sub-path,
see [Mounting under a sub-path](#mounting-under-a-sub-path).

### 3. Add a deploy script

```json
{
  "scripts": {
    "deploy": "convex-hosting deploy --dist dist"
  }
}
```

Run it where `CONVEX_DEPLOY_KEY` holds a production deploy key, for example in CI. For client-side
routes, add `--not-found-handling single-page-application` (see [Routing](#routing)).

### Keep existing HTTP routes at the root

Do not move stable webhook, auth, or API URLs just to add hosting. Leave the component's HTTP routes
unmounted and register the static catch-all in your existing router.

`convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

const app = defineApp();
app.use(hosting); // no httpPrefix

export default app;
```

`convex/http.ts`:

```ts
import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@samebase/convex-hosting";
import { components } from "./_generated/api";

const http = httpRouter();

// Register exact app routes first. Existing auth/webhook helpers can stay here.
// auth.addHttpRoutes(http);
registerStaticRoutes(http, components.hosting);

export default http;
```

Exact routes win over the static catch-all, so existing URLs keep working. To serve the site under a
prefix, pass `{ pathPrefix: "/app/" }` and upload with `--base-path /app/`. The component still owns
uploads, versions, and file storage. In this mode your action reads each file through its storage
URL, one more request than the component's own route makes.

### Using non-Vite bundlers

`deploy` runs your build through `npx convex deploy --cmd`, which sets the deployment URL in the
variable that your framework reads: `VITE_CONVEX_URL` for Vite, `NEXT_PUBLIC_CONVEX_URL` for
Next.js, `EXPO_PUBLIC_CONVEX_URL` for Expo, and `CONVEX_URL` when it finds no framework. Pick the
matching [immutable preset](#immutable-files).

## Deployment

`deploy` releases the backend and the site together:

```bash
npx @samebase/convex-hosting deploy --dist dist
```

1. It selects one target and prints it: the deployment of `CONVEX_DEPLOY_KEY`, or with
   `--preview-name <name>` and a project's preview deploy key, that preview deployment.
   `--preview-name` next to the deploy key of one deployment (production, development, or one
   preview deployment) fails before anything changes.
2. It makes a version ID and runs
   `npx convex deploy --cmd "<build> && convex-hosting upload --no-activate --version-id <id> ..."`.
   The build gets the deployment URL from `npx convex deploy`, and `CONVEX_HOSTING_VERSION_ID` and
   `CONVEX_HOSTING_BASE_PATH`. The files upload as a new version before the push replaces the
   functions, and the current version stays live.
3. It makes the new version live and checks the site at the `.convex.site` URL of the deployment,
   which answers also when the site has a custom domain. A static build (with `/index.html`) must
   answer 200 for `/index.html` with the ETag of the new file. A server-rendered build (without
   `/index.html`) must answer 200 for the `--verify-path` page (default `/`) with
   `<meta name="convex-hosting-version" content="<id>">`, which the TanStack Start adapter writes.
   Then `lib:getLiveVersion` must name the new version.

**First install:** when the component does not answer yet, `deploy` pushes the backend with the
build first, then uploads and makes the version live. The site answers 404 until the upload ends,
and a failed upload leaves it so until a rerun.

Run the releases of one target one at a time, for example with a CI concurrency group. A rollback is
a deploy of the older commit.

`upload` uploads a build without a backend push and makes it live unless you pass `--no-activate`:

```bash
npx @samebase/convex-hosting upload --dist dist
```

It targets the deployment of `CONVEX_DEPLOY_KEY`, the `--preview-name` deployment, or the
development deployment in `CONVEX_DEPLOYMENT` (`.env.local`). It does not build, so the build must
already contain the URL of that deployment. The version ID is kept with a digest of the files in
`<dist>/.convex-hosting/version.json`, so a rerun of the same build continues an interrupted upload
or reuses the finished version.

## Development workflow

Use your normal frontend dev server during development:

```bash
# Terminal 1
npx convex dev

# Terminal 2
npm run dev
```

For Vite, that keeps HMR and fast local feedback. The hosting component is the deploy target, not a
replacement dev server.

Before release, run one hosted smoke test against the development deployment. The build reads
`VITE_CONVEX_URL` from `.env.local`, which `npx convex dev` writes:

```bash
npm run build && npx @samebase/convex-hosting upload --dist dist
```

Then use `deploy` for production. This split keeps the dev loop fast while still testing the real
HTTP, caching, base-path, and routing behavior before shipping.

## Routing

Each version stores its routing settings, so they change with each release. The defaults are
`--html-handling auto-trailing-slash` and `--not-found-handling none`:

- `--html-handling <mode>`: how paths map to HTML files. `auto-trailing-slash` serves `/about.html`
  at `/about` and `/about/index.html` at `/about/`, and redirects to the canonical form.
  `force-trailing-slash`, `drop-trailing-slash`, and `none` (exact paths only) work as on
  Cloudflare.
- `--not-found-handling <mode>`: what a path with no file gets. `none` answers 404.
  `single-page-application` serves `/index.html` with status 200 to page loads
  (`Sec-Fetch-Mode: navigate`); a missing script still gets a 404. `404-page` serves the nearest
  `404.html` with status 404.

For client-side routes like `/dashboard/settings`:

```bash
npx @samebase/convex-hosting deploy --dist dist --not-found-handling single-page-application
```

`serveStaticAsset` ignores both settings and looks up exact paths, unless you pass `exact: false`.
Every response with status 400 or above gets `Cache-Control: no-store`.

### `_headers` and `_redirects`

`_headers` and `_redirects` at the root of the build output use
[Cloudflare's syntax](https://developers.cloudflare.com/workers/static-assets/headers/). The upload
parses them into the version's rules and does not serve the files. At most 100 header rules, and
2,000 static plus 100 dynamic redirects.

### `.assetsignore`

A `.assetsignore` file at the root of the build output excludes files with gitignore syntax, as on
Cloudflare. Dot files and dot directories are never uploaded, except `.well-known`.

### Immutable files

`--immutable <preset|glob>` names the paths whose bytes never change: `vite` (`/assets/**`, the
default), `next` (`/_next/static/**`), `astro` (`/_astro/**`), `sveltekit` (`/_app/immutable/**`),
or a gitignore-style glob. The upload does not guess hashes from file names: it marks the paths that
this setting selects. These files get `Cache-Control: public, max-age=31536000, immutable`. The
files of a newer version that is not live yet are reachable at these paths, so a server renderer
finds its scripts between the backend push and the switch; the files of a replaced version are not.
The setting is a promise: an upload fails when an immutable path has other bytes in the live version
or in a newer one.

## Reload on a new version

After a deploy, an open page that was loaded before it gets 404 for hashed files that the new
version does not have, for example a script that it loads at its next navigation. To reload such a
page when a new version goes live, expose the component's live version to your app:

`convex/hosting.ts`:

```ts
import { components } from "./_generated/api";
import { query } from "./_generated/server";

export const getLiveVersion = query({
  args: {},
  handler: async (ctx) => await ctx.runQuery(components.hosting.lib.getLiveVersion, {}),
});
```

Then reload when the version changes after the first value:

```tsx
import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "../convex/_generated/api";

export function useReloadOnNewVersion() {
  const live = useQuery(api.hosting.getLiveVersion);
  const firstVersionId = useRef<string | null>(null);
  useEffect(() => {
    if (!live) return;
    firstVersionId.current ??= live.versionId;
    if (live.versionId !== firstVersionId.current) location.reload();
  }, [live]);
}
```

## Mounting under a sub-path

Mount the static site under a sub-path if you have other routes at the root:

```ts
app.use(hosting, { httpPrefix: "/app/" });
```

Pass the same prefix to the CLI with `--base-path /app/`. It is stored in the version, and `deploy`
gives it to your build as `CONVEX_HOSTING_BASE_PATH`, so `vite.config.ts` can read it directly:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.CONVEX_HOSTING_BASE_PATH ?? "/",
});
```

Root-mounted apps don't need this; the default is `/`. For webpack use `publicPath`, for Next.js
`assetPrefix`.

## Custom routing (SSR, APIs)

`registerStaticRoutes` decides what every unmatched path returns. When your app needs to decide
instead, for example to server-render pages, write the catch-all route yourself and call
`serveStaticAsset` for uploaded files. Install the component without `httpPrefix`, as in
[Keep existing HTTP routes at the root](#keep-existing-http-routes-at-the-root).

```ts
import { httpRouter } from "convex/server";
import { serveStaticAsset } from "@samebase/convex-hosting";
import { components } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const file = await serveStaticAsset(ctx, components.hosting, request);
    if (file) return file;
    return await renderPage(request);
  }),
});

export default http;
```

`serveStaticAsset` returns the live version's file for the exact request path, with the same headers
as `registerStaticRoutes`, or `null` when the version does not handle the request. It does not map
`/` to `/index.html` and has no SPA fallback, so `/` reaches your code and the build needs no
`index.html`. A redirect rule from `_redirects` and a 304 are responses too. Pass `{ exact: false }`
to apply the version's `html_handling` and `not_found_handling`.

See
[`examples/tanstack-ssr/`](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
for TanStack Start pages rendered in a Convex HTTP action this way.

## Limits

- A version holds at most 4,000 files of at most 25 MiB each, with paths of at most 1,024 bytes, and
  at most 256 KiB of header and redirect rules.
- A `Range` request gets the whole file with status 200.
- Every file request runs a Convex HTTP action and a query, and a response with a body also reads
  storage. Each is billed as such. Edge cache hits for immutable files reduce it.
- A deployment runs one backend version: a page that is already open talks to the new backend after
  a release, so keep your functions compatible with the previous frontend.

## CLI options

```bash
npx @samebase/convex-hosting upload --dist <dir> [options]
npx @samebase/convex-hosting deploy --dist <dir> [options]

upload and deploy:
  --dist <dir>                 Build output directory (required)
  --component <name>           Component instance name (default: hosting)
  --preview-name <name>        Target the named preview deployment
  --immutable <preset|glob>    Paths whose bytes never change: vite (/assets/**, default), next
                               (/_next/static/**), astro (/_astro/**), sveltekit
                               (/_app/immutable/**), or a gitignore-style glob
  --html-handling <mode>       auto-trailing-slash (default), force-trailing-slash,
                               drop-trailing-slash, none
  --not-found-handling <mode>  none (default), single-page-application, 404-page
  --base-path <prefix>         Path prefix that the site is served under (default: /)

upload:
  --version-id <id>            Upload under this version ID
  --no-activate                Keep the current version live

deploy:
  --build-command <cmd>        Build command (default: npm run build)
  --verify-path <path>         Page with the version meta tag, for a build without /index.html,
                               relative to the base path (default: /)
```

If you mount the component under a different name with `app.use(hosting, { name: "custom" })`, pass
`--component custom` and replace every generated `components.hosting` reference with
`components.custom`.

## Troubleshooting

- **Every path answers 404:** no version is live yet, so run `deploy` or `upload`. With the
  component's own route, check its `httpPrefix`. With `registerStaticRoutes`, check that
  `convex/http.ts` calls it and that the component has no `httpPrefix`.
- **The page talks to the wrong deployment:** the build contains the deployment URL. `deploy` builds
  with the URL of its target; a build for `upload` reads `.env.local`, so build again before an
  upload to another deployment.

## Security

The upload API uses **internal functions** in the Component that can only be called via:

- `npx convex run` (requires Convex CLI authentication)
- Other Convex functions in the Component (server-side only)

This means unauthorized users **cannot** upload files to your site, even if they know your Convex
URL.

## How it works

1. **Build:** your bundler emits `dist/`.
2. **Upload:** the CLI hashes the build output, uploads a manifest and then the files through your
   authenticated Convex session, and the component records them as a new version.
3. **Activate:** one mutation makes the new version live.
4. **Serve:** one component query routes each request through Cloudflare's asset handler against the
   live version, and the HTTP action streams the selected file from storage.

## Repository

This README is the documentation of `@samebase/convex-hosting`, the main package. The rest of the
repository supports it:

| Path                                                                                                                                    | What it is                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`packages/convex-hosting`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting)                               | `@samebase/convex-hosting`: the component and the `convex-hosting` CLI                  |
| [`packages/convex-hosting-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start) | `@samebase/convex-hosting-tanstack-start`: TanStack Start pages in a Convex HTTP action |
| [`examples/spa`](https://github.com/samebase/convex-hosting/tree/main/examples/spa)                                                     | A Vite and React app served by the component                                            |
| [`examples/tanstack-ssr`](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)                                   | TanStack Start pages rendered in a Convex HTTP action                                   |

## Contributing

See [CONTRIBUTING.md](https://github.com/samebase/convex-hosting/blob/main/CONTRIBUTING.md).

## License

Apache-2.0
