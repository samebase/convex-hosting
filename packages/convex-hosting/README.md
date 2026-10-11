# Convex Hosting

[![npm version](https://badge.fury.io/js/@samebase%2Fconvex-hosting.svg)](https://badge.fury.io/js/@samebase/convex-hosting)

A Convex component for hosting static React/Vite apps directly on Convex: no separate hosting
provider, no DNS to wire up, no second deploy target. Run one command and your frontend is live at
`https://<deployment>.convex.site` alongside your backend. For server-rendered TanStack Start pages,
add
[`@samebase/convex-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-tanstack-start).

This is Samebase's fork of [get-convex/static-hosting](https://github.com/get-convex/static-hosting)
(Apache-2.0). It is not affiliated with or endorsed by Convex.

## Features

- 🚀 **One-command deploy:** build, push backend, and upload static files in a single step.
- 🔄 **SPA routing:** paths without an extension fall back to `index.html`.
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
    "deploy": "npx @samebase/convex-hosting deploy"
  }
}
```

That's it.

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

The `deploy` build step and `upload --build` set `VITE_CONVEX_URL`. For bundlers that use different
environment variable conventions, wrap your build script to pass through the value:

**For Expo:**

```json
{
  "scripts": {
    "build": "EXPO_PUBLIC_CONVEX_URL=${VITE_CONVEX_URL:-$EXPO_PUBLIC_CONVEX_URL} npx expo export --platform web"
  }
}
```

**For Next.js:**

```json
{
  "scripts": {
    "build": "NEXT_PUBLIC_CONVEX_URL=${VITE_CONVEX_URL:-$NEXT_PUBLIC_CONVEX_URL} next build"
  }
}
```

The pattern `${VITE_CONVEX_URL:-$VAR}` uses `VITE_CONVEX_URL` if set by the CLI and otherwise falls
back to your bundler-specific variable. This keeps both the CLI-driven build and standalone
`npm run build` working.

## Deployment

Deploy both Convex backend and static files with a single command:

```bash
npx convex login           # first time only
npx @samebase/convex-hosting deploy
```

The `deploy` command:

1. Builds your frontend with the production `VITE_CONVEX_URL`.
2. Deploys the Convex backend.
3. Uploads `dist/` to Convex.

For more control, you can run the two halves separately:

```bash
npx convex deploy
npx @samebase/convex-hosting upload --build --prod
```

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

Before release, run one hosted smoke test against the development deployment:

```bash
npx @samebase/convex-hosting upload --build
```

Then use `deploy` for production. This split keeps the dev loop fast while still testing the real
HTTP, caching, base-path, and SPA behavior before shipping.

## CLI options

```bash
npx @samebase/convex-hosting deploy [options]
  -d, --dist <path>         Path to dist directory (default: ./dist)
  -c, --component <name>    Component instance name (default: hosting)
      --skip-build          Skip the build step (use existing dist)
      --skip-convex         Skip Convex backend deployment
      --build-command <cmd> Build command to run (default: 'npm run build')
      --no-spa              Disable SPA fallback (404 instead of /index.html)
      --spa                 Enable SPA fallback (default)
      --cdn                 Use the legacy convex-fs integration
      --cdn-delete-function Legacy app function that deletes CDN blobs

npx @samebase/convex-hosting upload [options]
  -d, --dist <path>         Path to dist directory (default: ./dist)
  -c, --component <name>    Component instance name (default: hosting)
      --prod                Deploy to production deployment
      --preview-name <name> Upload to the named preview deployment
  -b, --build               Run 'npm run build' with VITE_CONVEX_URL set
      --build-command <cmd> Override the build command; implies --build
      --no-spa              Disable SPA fallback (404 instead of /index.html)
      --spa                 Enable SPA fallback (default)
      --cdn                 Use the legacy convex-fs integration
      --cdn-delete-function Legacy app function that deletes CDN blobs
  -j, --concurrency <n>     Parallel upload workers (default: 5)
```

`--preview-name` selects the deployment the same way as `npx convex run --preview-name`, so a dev or
production `CONVEX_DEPLOY_KEY` takes precedence over it.

Each upload is published atomically, so visitors never see a page that refers to assets that are not
available yet. Failed uploads leave the previous deployment live. Replaced non-HTML files stay
available for at least seven days, so pages that are already open can still load their scripts. A
later upload removes expired files. See [INTEGRATION.md](./INTEGRATION.md) for upload limits and
lifecycle details.

Convex HTTP routes currently support GET but not HEAD. Configure uptime checks to make a lightweight
GET request rather than a HEAD request.

If you mount the component under a different name with `app.use(hosting, { name: "custom" })`, pass
`--component custom` and replace every generated `components.hosting` reference with
`components.custom`.

Do not use `--cdn` for a new integration. It targets an older ConvexFS HTTP API and is retained only
for existing deployments. Legacy CDN users must keep app-owned root routing because `/fs/upload` and
`/fs/blobs/*` are root app routes. See `INTEGRATION.md` for the current limitation.

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

You'll also need to tell your bundler about the base path so the emitted HTML references the right
URLs. The CLI sets a `CONVEX_HOSTING_BASE_PATH` env var matching the component's mount when it runs
your build, so `vite.config.ts` can read it directly:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.CONVEX_HOSTING_BASE_PATH ?? "/",
});
```

Root-mounted apps don't need this; the default is `/`. For webpack use `publicPath`, for Next.js
`assetPrefix`.

## SPA routing

By default, requests for a path with no file extension that doesn't match an uploaded file fall back
to `index.html`, so client-side routes like `/dashboard/settings` work on reload. For a multi-page
app where unknown paths should be a real 404, deploy with `--no-spa`:

```bash
npx @samebase/convex-hosting deploy --no-spa
```

The setting is stored with the deployment, so it travels with the code you ship rather than living
in a separate env var. Requests for paths with an extension (e.g. `/missing.js`) always 404 when not
found, regardless of this setting.

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
2. **Upload:** the CLI uses your authenticated Convex session to generate signed upload URLs, push
   files to Convex storage, record metadata, and GC old deployments.
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
