# Integration Guide: @samebase/convex-hosting

This guide walks you through hosting a static React/Vite app on Convex using the
`@samebase/convex-hosting` component. Your frontend ends up at `https://<deployment>.convex.site`,
served alongside your Convex backend with SPA routing and smart caching.

## What this component gives you

- A drop-in HTTP handler that serves your static files from Convex storage
- One CLI command (`deploy`) that builds, deploys the backend, and uploads files
- Optional SPA fallback to `index.html` for client-side routing
- Long-term cache headers on hashed assets and ETag-based revalidation on HTML
- Optional live-reload notifications when a new deploy ships
- Authenticated uploads via the Convex CLI (no public upload endpoint)

## Quick Start

```bash
npm install @samebase/convex-hosting
```

Register the component and add a `deploy` script as described in [Manual Setup](#manual-setup).
Then:

```bash
npm run deploy
```

## Manual Setup

### `convex/convex.config.ts`

The default setup mounts the component's HTTP handler at the root and moves app-owned routes under
`/api`.

```typescript
import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

// Serve your own HTTP endpoints (convex/http.ts) under /api so the static
// site can own the root.
const app = defineApp({ httpPrefix: "/api" });
app.use(hosting, { httpPrefix: "/" });

export default app;
```

This is the fastest serving mode because the component reads its storage directly. It is appropriate
for new apps and apps whose HTTP routes can live under `/api`.

If existing webhook, auth, or API routes must stay at the root, use
[App-owned root routing](#app-owned-root-routing). To host the static site under a sub-path, see
[Mounting under a sub-path](#mounting-under-a-sub-path).

> Run `npx convex dev` after editing `convex.config.ts` so codegen picks up the component.

### App-owned root routing

Keep the app in control of `convex/http.ts` when changing existing route URLs would break clients or
third-party callbacks.

`convex/convex.config.ts`:

```typescript
import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

const app = defineApp();
app.use(hosting); // no httpPrefix

export default app;
```

`convex/http.ts`:

```typescript
import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@samebase/convex-hosting";
import { components } from "./_generated/api";

const http = httpRouter();

// Keep existing exact routes at their current URLs.
// auth.addHttpRoutes(http);
registerStaticRoutes(http, components.hosting);

export default http;
```

Exact routes win over the static catch-all. Uploads, deployment metadata, SPA configuration, and
file storage remain inside the component, so you can remove the old `exposeUploadApi` wrappers.
During a same-name 0.1.x→0.2.x migration this mode also keeps serving your existing v1 files from
app storage until the first 0.2.x upload, so the live site never drops to the setup page. This
compatibility mode adds an internal query and storage fetch on uncached requests. Use the
component-owned handler when preserving root-level app routes is not necessary.

### `package.json`

```json
{
  "scripts": {
    "deploy": "convex-hosting deploy --dist dist"
  }
}
```

Run it where `CONVEX_DEPLOY_KEY` holds a production deploy key, for example in CI.

## Deployment

```bash
# Push the backend, upload the build, activate it, and verify it
CONVEX_DEPLOY_KEY=<production deploy key> npx @samebase/convex-hosting deploy --dist dist
```

`deploy` selects one target (the deployment of `CONVEX_DEPLOY_KEY`, or `--preview-name <name>` with
a preview deploy key), makes a version ID, and runs
`npx convex deploy --cmd "<build> && convex-hosting upload --no-activate --version-id <id> ..."`, so
the files upload before the new functions go live. Then it activates the version and checks that the
site serves it. On a first install or an upgrade from 0.3.x, it pushes the backend with the build
first, then uploads and activates; the site answers 404 until the upload ends.

To upload a build without a backend push:

```bash
npx @samebase/convex-hosting upload --dist dist
```

Your app is live at `https://<deployment>.convex.site`.

## Development workflow

Do not use uploaded static files as the main development loop. Run the normal frontend dev server
alongside Convex:

```bash
npx convex dev
npm run dev
```

Vite keeps HMR, source maps, and transient UI state intact. Agent-written code does not change that
tradeoff. HMR may matter less while code is being produced, but it still matters when a person
verifies visuals and debugs interactions.

Use the hosted development deployment as a smoke-test target before release. The build reads
`VITE_CONVEX_URL` from `.env.local`, which `npx convex dev` writes:

```bash
npm run build && npx @samebase/convex-hosting upload --dist dist
```

That catches differences in HTTP routing, cache headers, SPA fallback, and base paths. Production
remains the one-command `deploy` flow.

## Live reload banner (optional)

Show users a banner when a new version is deployed:

### `convex/hosting.ts`

```typescript
import { exposeDeploymentQuery } from "@samebase/convex-hosting";
import { components } from "./_generated/api";

export const { getCurrentDeployment } = exposeDeploymentQuery(components.hosting);
```

### Frontend

```tsx
import { UpdateBanner } from "@samebase/convex-hosting/react";

function App() {
  return (
    <>
      <UpdateBanner message="New version available!" buttonText="Reload" />
      {/* rest of app */}
    </>
  );
}
```

`UpdateBanner` resolves `api.hosting.getCurrentDeployment` by default. To re-export the query under
a different module, pass the reference explicitly:

```tsx
import { api } from "../convex/_generated/api";
<UpdateBanner getCurrentDeployment={api.myModule.getCurrentDeployment} />;
```

For custom UI, use the hook:

```tsx
import { useDeploymentUpdates } from "@samebase/convex-hosting/react";

const { updateAvailable, reload, dismiss } = useDeploymentUpdates();
```

## Non-Vite bundlers

`deploy` runs the build through `npx convex deploy --cmd`, which sets the deployment URL in the
variable that the framework reads: `VITE_CONVEX_URL` for Vite, `NEXT_PUBLIC_CONVEX_URL` for Next.js,
`EXPO_PUBLIC_CONVEX_URL` for Expo, and `CONVEX_URL` when it finds no framework.

## Security

Upload functions are **internal** to the component. They can only be called via:

- `npx convex run` (requires Convex CLI authentication)
- Other Convex functions (server-side only)

This means unauthorized users cannot upload files, even if they know your Convex URL.

## CLI Reference

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

Target: every `npx convex` call of one command uses the same deployment. That is the deployment of
`CONVEX_DEPLOY_KEY`, the `--preview-name` deployment (with a preview deploy key or a login), or, for
`upload` only, the development deployment in `CONVEX_DEPLOYMENT`. `--preview-name` next to a
production or development deploy key fails before any write, because the Convex CLI would ignore it.
`deploy` needs a deploy key or `--preview-name`: without a key, `npx convex deploy` pushes to
production while `npx convex run` uses the development deployment.

Upload: the CLI collects the build output with Cloudflare's rules (`_headers` and `_redirects` at
the root become the version's rules and are not uploaded, `.assetsignore` excludes files, and dot
files are skipped except `.well-known`), hashes each file, and uploads the manifest as one file. The
component returns the files that it does not have; the CLI uploads them, 8 at a time, and records
each one. When the version is complete, the CLI activates it unless `--no-activate` is given. The
version ID is kept with a digest of the files in `<dist>/.convex-hosting/version.json`, so a rerun
of the same build continues an interrupted upload or reuses the finished version.

Limits: at most 4,000 files per version, 25 MiB per file, 1,024 bytes per path, and 256 KiB of
header and redirect rules.

Verification (`deploy`): for a build with `/index.html`, the ETag of `<base path>index.html` must be
the new file's; otherwise the `--verify-path` page must carry
`<meta name="convex-hosting-version" content="<id>">`, which a build can write from
`CONVEX_HOSTING_VERSION_ID`. Then `lib:getLiveVersion` must name the new version.

Convex HTTP routers currently expose GET but not HEAD routes. Uptime monitors must use a lightweight
GET request.

## Mounting under a sub-path

To mount under `/app/` (for example, if you have other HTTP routes at the root):

```typescript
app.use(hosting, { httpPrefix: "/app/" });
```

Pass the same prefix to the CLI with `--base-path /app/`. It is stored in the version, and `deploy`
gives it to the build as `CONVEX_HOSTING_BASE_PATH`, so `vite.config.ts` can read it:

```typescript
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.CONVEX_HOSTING_BASE_PATH ?? "/",
});
```

Root-mounted apps don't need this; the default is `/`. Webpack/Next.js equivalents: `publicPath` and
`assetPrefix`.

## SPA routing

A request for a path with no uploaded file gets a 404 by default. For client-side routes, upload
with SPA handling:

```bash
npx @samebase/convex-hosting deploy --dist dist --not-found-handling single-page-application
```

A page load (`Sec-Fetch-Mode: navigate`) of an unknown path then gets `index.html`, and a missing
script still gets a 404. The setting is stored in the version, so it changes with each release.

## Switching from @convex-dev/static-hosting

Follow
[Switching from @convex-dev/static-hosting](./README.md#switching-from-convex-devstatic-hosting) in
the README. Mount the component with `{ name: "staticHosting" }` to keep the uploaded files and
URLs. An app on 0.1.x first follows upstream's
[0.1.x to 0.2.x migration guide](https://github.com/get-convex/static-hosting/blob/main/MIGRATION.md).

## Troubleshooting

### 404s on every path

Run `npx convex dev` (or `npx convex deploy`) after adding the component. In component-owned mode,
verify its `httpPrefix`. In app-owned mode, verify that `registerStaticRoutes` is called from
`convex/http.ts` and the component itself has no `httpPrefix`.

### Wrong `VITE_CONVEX_URL` in the built bundle

```bash
# Right: npx convex deploy sets VITE_CONVEX_URL for the target deployment
npx @samebase/convex-hosting deploy --dist dist

# Wrong for production: the build uses VITE_CONVEX_URL from .env.local
npm run build && CONVEX_DEPLOY_KEY=<production key> npx @samebase/convex-hosting upload --dist dist
```

### "Cannot find module convex.config"

Make sure you've installed the package and it's listed in `package.json`:

```bash
npm install @samebase/convex-hosting
```

### Component name mismatch

If you've renamed the component instance with `app.use(hosting, { name: "custom" })`, pass it to the
CLI and replace every generated `components.hosting` reference with `components.custom`:

```bash
npx @samebase/convex-hosting upload --dist dist --component custom
```

## API Reference

### `registerStaticRoutes(http, component, options?)`

Registers a static catch-all in the app's `convex/http.ts`. Use it when exact app routes must remain
at the same root. `pathPrefix`, `spaFallback`, and `cdnBaseUrl` are supported. The component must be
installed without an `httpPrefix` so only the app owns that URL space.

### `serveStaticAsset(ctx, component, request, options?)`

Serves an uploaded file from an app-owned HTTP action, or returns `null` when no file matches so the
action can continue with its own routing (server rendering, prerendered pages, redirects). Responses
match `registerStaticRoutes`. The lookup is exact: `/` is not mapped to `/index.html`, and
`spaFallback` defaults to `false`. `path` (the decoded file path, defaulting to the decoded request
path, starting with `/` and without your route's prefix), `spaFallback`, and `cdnBaseUrl` are
supported. A request path with malformed percent-encoding returns `null`. A found file whose storage
can't be read gets a 500 response. The component must be installed without an `httpPrefix`.

### `decodeRequestPath(pathname)`

Decodes a URL pathname the way the static handlers do. Returns `null` for malformed
percent-encoding.

### `exposeDeploymentQuery(component)`

Returns `{ getCurrentDeployment }`: a public query that wraps the component's deployment singleton.
Add this only if you use `<UpdateBanner />` or `useDeploymentUpdates`.

### `getConvexUrl()`

Browser-only. Returns `https://<deployment>.convex.cloud` when the page is served from
`<deployment>.convex.site`.

## Additional Resources

- [README](./README.md)
- [Upstream 0.1.x to 0.2.x migration guide](https://github.com/get-convex/static-hosting/blob/main/MIGRATION.md)
- [`examples/spa`](https://github.com/samebase/convex-hosting/tree/main/examples/spa): Working
  example app
- [Component source](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting/src/component)
