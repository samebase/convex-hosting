# Convex Hosting

[![npm version](https://badge.fury.io/js/@samebase%2Fconvex-hosting.svg)](https://badge.fury.io/js/@samebase/convex-hosting)

A Convex component for hosting static React/Vite apps directly on Convex: no separate hosting
provider, no DNS to wire up, no second deploy target. Run one command and your frontend is live at
`https://<deployment>.convex.site` alongside your backend. For server-rendered TanStack Start pages,
add
[`@samebase/convex-hosting-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start).

This is Samebase's fork of [get-convex/static-hosting](https://github.com/get-convex/static-hosting)
(Apache-2.0). It is not affiliated with or endorsed by Convex.

## Features

- 🚀 **One-command deploy:** build, push backend, and upload static files in a single step.
- 🔄 **SPA routing:** with `--not-found-handling single-page-application`, page loads of unknown
  paths get `index.html`, and a missing script still gets a 404.
- ⚡ **Smart caching:** static files are cached for speed, with safe updates when a new version is
  deployed.
- 🔔 **Deployment update notifications:** show connected users a prompt when a new version is ready.
- 🔒 **Authenticated uploads:** uploads go through the Convex CLI's authenticated session; there's
  no public upload endpoint.
- 🧹 **Automatic cleanup:** replaced non-HTML files stay available for at least seven days, so open
  pages keep working, and a later deploy removes them.

## Quick Start

> **Coming from `@convex-dev/static-hosting`?** See
> [Switching from @convex-dev/static-hosting](#switching-from-convex-devstatic-hosting).

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

This is the fastest serving mode. The component owns `/`, while your app's `convex/http.ts` routes
move under `/api/...`.

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

Run it where `CONVEX_DEPLOY_KEY` holds a production deploy key, for example in CI.

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

Exact routes win over the static catch-all, so existing URLs keep working. The component still owns
uploads, deployment state, and file storage. This mode adds an internal query and storage fetch on
an uncached request, so prefer the component-owned mode when you do not need root-level app routes.

### Using non-Vite bundlers

`deploy` runs your build through `npx convex deploy --cmd`, which sets the deployment URL in the
variable that your framework reads: `VITE_CONVEX_URL` for Vite, `NEXT_PUBLIC_CONVEX_URL` for
Next.js, `EXPO_PUBLIC_CONVEX_URL` for Expo, and `CONVEX_URL` when it finds no framework.

## Deployment

`deploy` releases the backend and the site together:

```bash
npx @samebase/convex-hosting deploy --dist dist
```

1. It selects one target: the deployment of `CONVEX_DEPLOY_KEY`, or with `--preview-name <name>` and
   a preview deploy key, that preview deployment. `--preview-name` next to a production or
   development deploy key fails before anything changes.
2. It makes a version ID and runs
   `npx convex deploy --cmd "<build> && convex-hosting upload --no-activate --version-id <id> ..."`.
   The build gets the deployment URL from `npx convex deploy`, and `CONVEX_HOSTING_VERSION_ID` and
   `CONVEX_HOSTING_BASE_PATH`. The files upload before the new functions go live.
3. It activates the version, then checks the site: the ETag of `/index.html`, or for a build without
   `/index.html` the `<meta name="convex-hosting-version" content="<id>">` tag of the
   `--verify-path` page, and `lib:getLiveVersion`.

On a first install, and on an upgrade from 0.3.x, the component does not answer yet: `deploy` pushes
the backend with the build first, then uploads and activates. The site answers 404 until the upload
ends. Run the releases of one target one at a time, for example with a CI concurrency group.

`upload` uploads a build without a backend push and activates it unless you pass `--no-activate`:

```bash
npx @samebase/convex-hosting upload --dist dist
```

It targets the deployment of `CONVEX_DEPLOY_KEY`, the `--preview-name` deployment, or the
development deployment in `CONVEX_DEPLOYMENT` (`.env.local`). The version ID is kept with a digest
of the files in `<dist>/.convex-hosting/version.json`, so a rerun of the same build continues or
reuses its version.

Your app is live at `https://<deployment>.convex.site`.

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
HTTP, caching, base-path, and SPA behavior before shipping.

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
  --skip-build                 Upload the existing build output
  --verify-path <path>         Page with the version meta tag, for a build without /index.html,
                               relative to the base path (default: /)
```

Without `--html-handling` and `--not-found-handling`, `registerStaticRoutes` uses
`auto-trailing-slash` and `none`, and `serveStaticAsset` looks up exact paths.

The CLI follows Cloudflare's rules for the build output: `_headers` and `_redirects` at its root
become the version's header and redirect rules and are not uploaded, `.assetsignore` excludes files,
and dot files are skipped except `.well-known`. A version holds at most 4,000 files of at most 25
MiB each, paths of at most 1,024 bytes, and at most 256 KiB of rules. Immutable paths get a one-year
cache, and pages that are already open still load them from the previous versions after a release.

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

If you want a banner that prompts users to reload when a new deployment ships, expose the deployment
query in your app and drop in `<UpdateBanner />`:

`convex/hosting.ts`:

```ts
import { exposeDeploymentQuery } from "@samebase/convex-hosting";
import { components } from "./_generated/api";

export const { getCurrentDeployment } = exposeDeploymentQuery(components.hosting);
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

`UpdateBanner` resolves `api.hosting.getCurrentDeployment` automatically. If you re-export the query
under a different module name, pass it explicitly:

```tsx
import { api } from "../convex/_generated/api";
<UpdateBanner getCurrentDeployment={api.myModule.getCurrentDeployment} />;
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

## SPA routing

By default, a request for a path with no uploaded file gets a 404. For client-side routes like
`/dashboard/settings`, upload with SPA handling:

```bash
npx @samebase/convex-hosting deploy --dist dist --not-found-handling single-page-application
```

A page load (`Sec-Fetch-Mode: navigate`) of an unknown path then gets `index.html`, and a missing
script still gets a 404. The setting is stored in the version, so it changes with each release.

## Custom routing (SSR, prerendered pages)

`registerStaticRoutes` decides what every unmatched path returns. When your app needs to decide
instead, for example to server-render pages, serve prerendered pages next to an SPA shell, or
redirect to canonical URLs, write the catch-all route yourself and call `serveStaticAsset` for
uploaded files. Install the component without `httpPrefix`, as in
[Keep existing HTTP routes at the root](#keep-existing-http-routes-at-the-root).

```ts
import { httpRouter } from "convex/server";
import { decodeRequestPath, serveStaticAsset } from "@samebase/convex-hosting";
import { components } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const file = await serveStaticAsset(ctx, components.hosting, request);
    if (file) return file;

    // A missing bundle file is a 404, not a page.
    const path = decodeRequestPath(new URL(request.url).pathname);
    if (path === null || path.startsWith("/assets/")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return await renderPage(request);
  }),
});

export default http;
```

`serveStaticAsset` returns the file with the same headers as `registerStaticRoutes`, or `null` when
no file matches, including a request path with malformed percent-encoding. It never returns the
setup page or a 404, so your code decides what happens next. Only a found file whose storage can't
be read gets an error response (500). The lookup is exact: `/` is not mapped to `/index.html`, and
SPA fallback is off unless you pass `spaFallback: true`.

Pass `path` to serve a different file, such as a prerendered page or the SPA shell. It is the
decoded path of the uploaded file, starting with `/`. If your route has a prefix, remove it from
`path`:

```ts
const page = await serveStaticAsset(ctx, components.hosting, request, {
  path: "/about/index.html",
});
const shell = await serveStaticAsset(ctx, components.hosting, request, {
  path: "/index.html",
});
```

When the backend renders your pages, pushing the backend and uploading files are separate steps, so
right after a deploy a page can briefly refer to scripts that are not uploaded yet. That is why the
missing-asset response above uses `Cache-Control: no-store`: a CDN would otherwise keep serving
the 404.

Use `decodeRequestPath` for your own path checks, so an encoded request such as `/%61ssets/app.js`
still matches `/assets/`.

See
[`examples/tanstack-ssr/`](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr)
for TanStack Start pages rendered in a Convex HTTP action this way.

## Switching from @convex-dev/static-hosting

This package continues `@convex-dev/static-hosting` 0.2. To switch an app:

1. Replace the dependency with `@samebase/convex-hosting`, and change every import from
   `@convex-dev/static-hosting` to `@samebase/convex-hosting`, including `/convex.config` and
   `/react`.
2. Keep the existing component instance, so the uploaded files and the site URLs stay:

   ```ts
   import hosting from "@samebase/convex-hosting/convex.config";

   app.use(hosting, { name: "staticHosting", httpPrefix: "/" });
   ```

   Keep the `httpPrefix` the app used before. The code keeps using `components.staticHosting`, and
   the CLI finds this instance without `--component`. It prints a note that the default name is now
   `hosting`.

3. Rename `convex/staticHosting.ts` to `convex/hosting.ts`. `<UpdateBanner />` and
   `useDeploymentUpdates()` look up `api.hosting.getCurrentDeployment` by default. To keep the old
   file, pass `api.staticHosting.getCurrentDeployment` to them instead.
4. In package scripts, replace `@convex-dev/static-hosting` with `@samebase/convex-hosting` (for
   example `npx @samebase/convex-hosting deploy`) and the bare `static-hosting` command with
   `convex-hosting`. In the bundler config, replace `STATIC_HOSTING_BASE_PATH` with
   `CONVEX_HOSTING_BASE_PATH`.
5. Deploy as usual.

To use the new default name instead, remove `name: "staticHosting"`, replace
`components.staticHosting` with `components.hosting`, and deploy. The new instance starts empty, so
the deploy uploads the files again.

An app on `@convex-dev/static-hosting` 0.1.x first follows upstream's
[0.1.x to 0.2.x migration guide](https://github.com/get-convex/static-hosting/blob/main/MIGRATION.md),
because 0.2 moved the files into the component.

## How it works

1. **Build:** your bundler emits `dist/`.
2. **Upload:** the CLI hashes the build output, uploads a manifest and the files that the component
   does not have yet through your authenticated Convex session, and activates the new version.
3. **Serve:** an HTTP action looks up the requested path, streams the file with the right
   `Content-Type`, applies long-term caching for hashed assets, and falls back to `index.html` for
   SPA routes.

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
