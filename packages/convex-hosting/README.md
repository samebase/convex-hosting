# Convex Hosting

[![npm version](https://badge.fury.io/js/@samebase%2Fconvex-hosting.svg)](https://badge.fury.io/js/@samebase/convex-hosting)

A Convex component that hosts a web app directly on Convex: no separate hosting provider, no DNS to
wire up, no second deploy target. Run one command and your frontend is live at
`https://<deployment>.convex.site` alongside your backend. For server-rendered TanStack Start pages,
add
[`@samebase/convex-hosting-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start).

This is Samebase's fork of [get-convex/static-hosting](https://github.com/get-convex/static-hosting)
(Apache-2.0). It is not affiliated with or endorsed by Convex.

## Features

- 🚀 **One-command deploy:** build, upload the files, push the backend, make the new version live,
  and verify it.
- 🧭 **Cloudflare's routing rules:** requests go through the code of Cloudflare's Workers Static
  Assets handler, so `html_handling`, `not_found_handling`, `_headers`, `_redirects`, and
  `.assetsignore` work as on Cloudflare.
- ⚡ **Caching:** every file gets an ETag and 304 answers; hashed files get a one-year immutable
  cache.
- 🔁 **One live version:** a deploy uploads a new version and then switches one pointer. Hashed
  files of previous versions stay reachable, so pages that are already open still load their
  scripts.
- 🔔 **Deployment update notifications:** show connected users a prompt when a new version is live.
- 🔒 **Authenticated uploads:** uploads go through the Convex CLI's authenticated session; there's
  no public upload endpoint.
- 🧹 **Automatic cleanup:** an hourly job deletes versions that were replaced more than seven days
  ago, and unfinished uploads.

## Quick Start

> **Upgrading from 0.3.x or coming from `@convex-dev/static-hosting`?** 0.4 is a new install. See
> [Upgrading to 0.4](#upgrading-to-04).

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
3. It makes the new version live, then checks the site: a 200 with the new ETag for `/index.html`,
   or for a build without `/index.html` a 200 with the
   `<meta name="convex-hosting-version" content="<id>">` tag for the `--verify-path` page (the
   TanStack Start adapter writes it), and `lib:getLiveVersion`.

The check fetches the `.convex.site` URL of the deployment. For a site on a custom domain, pass the
site's origin with `--site-url https://app.example.com`; it is required when the deployment URL is
not a `.convex.cloud` URL.

**First install:** when the component does not answer yet (a new install, or an upgrade from 0.3.x),
`deploy` pushes the backend with the build first, then uploads and makes the version live. The site
answers 404 until the upload ends, and a failed upload leaves it so until a rerun.

Run the releases of one target one at a time, for example with a CI concurrency group. A rollback is
a deploy of the older commit.

`deploy --skip-build` uploads the existing build output. It reuses the version ID that the build got
from the deploy that made it (`<dist>/.convex-hosting/version.json`); a server-rendered build
without that file stops before any change.

`upload` uploads a build without a backend push and makes it live unless you pass `--no-activate`:

```bash
npx @samebase/convex-hosting upload --dist dist
```

It targets the deployment of `CONVEX_DEPLOY_KEY`, the `--preview-name` deployment, or the
development deployment in `CONVEX_DEPLOYMENT` (`.env.local`). The version ID is kept with a digest
of the files in `<dist>/.convex-hosting/version.json`, so a rerun of the same build continues an
interrupted upload or reuses the finished version.

## Development workflow

Use your normal frontend dev server during development:

```bash
# Terminal 1
npx convex dev

# Terminal 2
npm run dev
```

For Vite, that keeps HMR and fast local feedback. The hosting component is the deploy target, not a
replacement dev server. Uploading every edit to a development deployment is slower and loses HMR,
even when an agent writes most of the code. Humans still need the quick loop for visual checks,
transient UI state, and debugging.

Before release, run one hosted smoke test against the development deployment. The build reads
`VITE_CONVEX_URL` from `.env.local`, which `npx convex dev` writes:

```bash
npm run build && npx @samebase/convex-hosting upload --dist dist
```

Then use `deploy` for production. This split keeps the dev loop fast while still testing the real
HTTP, caching, base-path, and routing behavior before shipping.

## Routing

Each version stores its routing settings, so they change with each release. Without flags,
`registerStaticRoutes` and the component's own route use `auto-trailing-slash` and `none`:

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
Every response with status 400 or above gets `Cache-Control: no-store`, so a CDN never keeps an
error.

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
or a gitignore-style glob. These files get `Cache-Control: public, max-age=31536000, immutable`, and
they stay reachable from the previous versions after a release, so a page that was open before it
still loads its lazy scripts. Other paths never fall back. The setting is a promise: an upload fails
when an immutable path has other bytes in a previous version.

## Limits

- A version holds at most 4,000 files of at most 25 MiB each, with paths of at most 1,024 bytes, and
  at most 256 KiB of header and redirect rules.
- A `Range` request gets the whole file with status 200.
- Every file request runs a Convex HTTP action, a query, and a storage read, and is billed as such.
  Edge cache hits for immutable files reduce it.
- A deployment runs one backend version: a page that is already open talks to the new backend after
  a release, so keep your functions compatible with the previous frontend.

## CLI options

```bash
npx @samebase/convex-hosting upload --dist <dir> [options]
npx @samebase/convex-hosting deploy --dist <dir> [options]

upload and deploy:
  --dist <dir>                 Build output directory (required)
  --component <name>           Component instance name (default: hosting, then staticHosting)
  --preview-name <name>        Target the named preview deployment
  --immutable <preset|glob>    Paths whose bytes never change: vite (/assets/**, default), next
                               (/_next/static/**), astro (/_astro/**), sveltekit
                               (/_app/immutable/**), or a gitignore-style glob
  --html-handling <mode>       auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none
  --not-found-handling <mode>  single-page-application, 404-page, none
  --base-path <prefix>         Path prefix that the site is served under (default: /)

upload:
  --version-id <id>            Upload under this version ID
  --no-activate                Keep the current version live

deploy:
  --build-command <cmd>        Build command (default: npm run build)
  --skip-build                 Upload the existing build output under its version ID
  --verify-path <path>         Page with the version meta tag, for a build without /index.html,
                               relative to the base path (default: /)
  --site-url <url>             Origin that the check fetches (default: the .convex.site URL of the
                               deployment). Required for a custom domain
```

If you mount the component under a different name with `app.use(hosting, { name: "custom" })`, pass
`--component custom` and replace every generated `components.hosting` reference with
`components.custom`.

## Security

The upload API uses **internal functions** in the Component that can only be called via:

- `npx convex run` (requires Convex CLI authentication)
- Other Convex functions in the Component (server-side only)

This means unauthorized users **cannot** upload files to your site, even if they know your Convex
URL.

## Reload prompt after deploy (optional)

If you want a banner that prompts users to reload when a new version goes live, expose the
deployment query in your app and drop in `<UpdateBanner />`:

`convex/hosting.ts`:

```ts
import { exposeDeploymentQuery } from "@samebase/convex-hosting";
import { components } from "./_generated/api";

export const { getLiveVersion } = exposeDeploymentQuery(components.hosting);
```

`src/App.tsx`:

```tsx
import { UpdateBanner } from "@samebase/convex-hosting/react";

function App() {
  return (
    <>
      <UpdateBanner message="New version!" buttonText="Reload" />
      {/* ... */}
    </>
  );
}
```

`UpdateBanner` resolves `api.hosting.getLiveVersion` automatically. If you re-export the query under
a different module name, pass it explicitly:

```tsx
import { api } from "../convex/_generated/api";
<UpdateBanner getLiveVersion={api.myModule.getLiveVersion} />;
```

For custom UI, use the hook:

```tsx
import { useDeploymentUpdates } from "@samebase/convex-hosting/react";

const { updateAvailable, reload, dismiss } = useDeploymentUpdates();
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

## Upgrading to 0.4

0.4 is a new install. The component's tables changed completely, so the upgrade starts with no live
version, and nothing from 0.3.x is served again:

1. If you still use `@convex-dev/static-hosting`, replace the dependency with
   `@samebase/convex-hosting`, change every import, including `/convex.config` and `/react`, and
   rename the `static-hosting` command to `convex-hosting` and `STATIC_HOSTING_BASE_PATH` to
   `CONVEX_HOSTING_BASE_PATH`. An instance mounted as `staticHosting` can keep its name: the CLI
   finds it without `--component`.
2. Remove `--no-spa` and `--cdn` from your scripts, and `spaFallback`, `cdnBaseUrl`, and `path` from
   `registerStaticRoutes` and `serveStaticAsset` calls. Add
   `--not-found-handling single-page-application` for an SPA.
3. Export `getLiveVersion` instead of `getCurrentDeployment` from `convex/hosting.ts`. A query
   reference that you pass to `UpdateBanner` or `useDeploymentUpdates` goes in the `getLiveVersion`
   prop or argument.
4. Run `deploy`. It pushes the backend first, then uploads; the site answers 404 until the upload
   ends.
5. Delete the old tables (`staticAssets`, `stagedAssets`, `retiredAssets`, `pendingStorageCleanup`,
   `pendingBlobCleanup`, `cleanupState`, and `deploymentInfo`) in the Convex dashboard. The upgrade
   leaves them and their documents in place. The hourly cleanup deletes the 0.3.x files from the
   component's storage, because no 0.4 version refers to them, so a downgrade needs a new upload.

An app on `@convex-dev/static-hosting` 0.1.x kept its files in the app's own storage. 0.4 does not
read them; upstream's
[0.1.x to 0.2.x migration guide](https://github.com/get-convex/static-hosting/blob/main/MIGRATION.md)
describes how to audit them before you delete them.

## How it works

1. **Build:** your bundler emits `dist/`.
2. **Upload:** the CLI hashes the build output, uploads a manifest and then the files through your
   authenticated Convex session, and the component records them as a new version.
3. **Activate:** one mutation makes the new version live.
4. **Serve:** one component query routes each request through Cloudflare's asset handler against the
   live version, and the HTTP action streams the selected file from storage.

## Example

See [`examples/spa/`](https://github.com/samebase/convex-hosting/tree/main/examples/spa) for a
complete Vite + React app, and
[`examples/tanstack-ssr/`](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
for server rendering with TanStack Start.

```bash
pnpm install
cd examples/spa
pnpm run dev
```

## Contributing

See [CONTRIBUTING.md](https://github.com/samebase/convex-hosting/blob/main/CONTRIBUTING.md).

## License

Apache-2.0
