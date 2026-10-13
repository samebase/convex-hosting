# Integration Guide: @samebase/convex-hosting

This guide walks you through hosting a web app on Convex with the `@samebase/convex-hosting`
component. Your frontend ends up at `https://<deployment>.convex.site`, served alongside your Convex
backend by the code of Cloudflare's Workers Static Assets handler.

## What this component gives you

- A drop-in HTTP handler that serves the live version of your site from Convex storage
- One CLI command (`deploy`) that builds, uploads the files, pushes the backend, makes the new
  version live, and verifies it
- Cloudflare's routing rules: `html_handling`, `not_found_handling` (SPA or 404 page), `_headers`,
  `_redirects`, and `.assetsignore`
- ETags and 304 answers for every file, and a one-year immutable cache for hashed files
- Hashed files of previous versions stay reachable, so open pages keep loading their scripts
- Optional live-reload notifications when a new version goes live
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

Exact routes win over the static catch-all. Uploads, versions, routing settings, and file storage
remain inside the component. In this mode the app's action reads each file through its storage URL,
one more request than the component-owned handler makes.

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
# Build, upload the files, push the backend, make the version live, and verify it
CONVEX_DEPLOY_KEY=<production deploy key> npx @samebase/convex-hosting deploy --dist dist
```

`deploy` selects one target (the deployment of `CONVEX_DEPLOY_KEY`, or `--preview-name <name>` with
a project's preview deploy key), makes a version ID, and runs
`npx convex deploy --cmd "<build> && convex-hosting upload --no-activate --version-id <id> ..."`, so
the files upload as a new version before the new functions go live. Then it makes the version live
and checks that the site serves it.

First install: when the component does not answer yet (a new install, or an upgrade from 0.3.x),
`deploy` pushes the backend with the build first, then uploads and makes the version live. The site
answers 404 until the upload ends.

Run the releases of one target one at a time, for example with a CI concurrency group. A rollback is
a deploy of the older commit.

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

That catches differences in HTTP routing, cache headers, routing rules, and base paths. Production
remains the one-command `deploy` flow.

## Routing

Each version stores its routing settings. Without flags, the component's handler and
`registerStaticRoutes` use `--html-handling auto-trailing-slash` and `--not-found-handling none`.

- `--html-handling`: `auto-trailing-slash` serves `/about.html` at `/about` and `/about/index.html`
  at `/about/`, and redirects to the canonical form. `force-trailing-slash`, `drop-trailing-slash`,
  and `none` (exact paths only) work as on Cloudflare.
- `--not-found-handling`: `none` answers 404. `single-page-application` serves `/index.html` to page
  loads (`Sec-Fetch-Mode: navigate`), and a missing script still gets a 404. `404-page` serves the
  nearest `404.html` with status 404.

For client-side routes:

```bash
npx @samebase/convex-hosting deploy --dist dist --not-found-handling single-page-application
```

`_headers` and `_redirects` at the root of the build output use Cloudflare's syntax. The upload
parses them into the version's rules (at most 100 header rules, 2,000 static and 100 dynamic
redirects) and does not serve the files. `.assetsignore` excludes files with gitignore syntax, and
dot files are never uploaded, except `.well-known`.

`--immutable` names the paths whose bytes never change: the presets `vite` (`/assets/**`, the
default), `next` (`/_next/static/**`), `astro` (`/_astro/**`), and `sveltekit`
(`/_app/immutable/**`), or a gitignore-style glob. These files get
`Cache-Control: public, max-age=31536000, immutable` and stay reachable from the previous versions
after a release. An upload fails when an immutable path has other bytes in a previous version.

Every response with status 400 or above gets `Cache-Control: no-store`.

## Live reload banner (optional)

Show users a banner when a new version goes live:

### `convex/hosting.ts`

```typescript
import { exposeDeploymentQuery } from "@samebase/convex-hosting";
import { components } from "./_generated/api";

export const { getLiveVersion } = exposeDeploymentQuery(components.hosting);
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

`UpdateBanner` resolves `api.hosting.getLiveVersion` by default. To re-export the query under a
different module, pass the reference explicitly:

```tsx
import { api } from "../convex/_generated/api";
<UpdateBanner getLiveVersion={api.myModule.getLiveVersion} />;
```

For custom UI, use the hook:

```tsx
import { useDeploymentUpdates } from "@samebase/convex-hosting/react";

const { updateAvailable, reload, dismiss } = useDeploymentUpdates();
```

## Non-Vite bundlers

`deploy` runs the build through `npx convex deploy --cmd`, which sets the deployment URL in the
variable that the framework reads: `VITE_CONVEX_URL` for Vite, `NEXT_PUBLIC_CONVEX_URL` for Next.js,
`EXPO_PUBLIC_CONVEX_URL` for Expo, and `CONVEX_URL` when it finds no framework. Pass the matching
`--immutable` preset.

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
  --skip-build                 Upload the existing build output under its version ID
  --verify-path <path>         Page with the version meta tag, for a build without /index.html,
                               relative to the base path (default: /)
  --site-url <url>             Origin that the check fetches (default: the .convex.site URL of the
                               deployment). Required for a custom domain
```

Target: every `npx convex` call of one command uses the same deployment. That is the deployment of
`CONVEX_DEPLOY_KEY`, the `--preview-name` deployment (with a project's preview deploy key,
`preview:<team>:<project>|...`, or a login), or, for `upload` only, the development deployment in
`CONVEX_DEPLOYMENT`. `--preview-name` next to the deploy key of one deployment (production,
development, or a preview deployment's own key, `preview:<deployment>|...`) fails before any write,
because the Convex CLI would ignore it. Both commands print the target first. `deploy` needs a
deploy key or `--preview-name`: without a key, `npx convex deploy` pushes to production while
`npx convex run` uses the development deployment.

Upload: the CLI collects the build output with Cloudflare's rules, hashes each file, and uploads the
manifest as one file. The component returns the files that it does not have; the CLI uploads them, 8
at a time, and records each one. When the version is complete, the CLI makes it live unless
`--no-activate` is given. The version ID is kept with a digest of the files in
`<dist>/.convex-hosting/version.json`, so a rerun of the same build continues an interrupted upload
or reuses the finished version. `deploy --skip-build` reuses the version ID in that file, because
the build wrote it into its pages; a build without `/index.html` and without that file stops before
any change.

Limits: at most 4,000 files per version, 25 MiB per file, 1,024 bytes per path, and 256 KiB of
header and redirect rules. A `Range` request gets the whole file with status 200.

Verification (`deploy`): for a build with `/index.html`, `<base path>index.html` must answer 200
with the new file's ETag; otherwise the `--verify-path` page must answer 200 and carry
`<meta name="convex-hosting-version" content="<id>">`, which the TanStack Start adapter writes from
`CONVEX_HOSTING_VERSION_ID`. Then `lib:getLiveVersion` must name the new version. The pages come
from the `.convex.site` URL of the deployment, or from `--site-url` for a custom domain.

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

## Upgrading to 0.4

0.4 is a new install: the component's tables changed completely. Follow
[Upgrading to 0.4](./README.md#upgrading-to-04) in the README. The first `deploy` pushes the backend
before it uploads, so the site answers 404 until the upload ends, and the old tables stay until you
delete them in the Convex dashboard.

## Troubleshooting

### 404s on every path

Run `deploy` (or `upload`) after adding the component: until a version is live, every path
answers 404. In component-owned mode, verify its `httpPrefix`. In app-owned mode, verify that
`registerStaticRoutes` is called from `convex/http.ts` and the component itself has no `httpPrefix`.

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
at the same root. `pathPrefix` (default `/`) needs the same `--base-path` at upload. The version's
routing settings apply, and a request that the version does not handle gets a 404 with
`Cache-Control: no-store`. The component must be installed without an `httpPrefix` so only the app
owns that URL space.

### `serveStaticAsset(ctx, component, request, options?)`

Serves the live version's file from an app-owned HTTP action, or returns `null` when the version
does not handle the request, so the action can continue with its own routing (server rendering,
APIs, redirects). The lookup is exact by default: `/` is not mapped to `/index.html`, there is no
SPA fallback, and the build needs no `index.html`. `_redirects` rules and 304 answers still apply.
Pass `{ exact: false }` to apply the version's `html_handling` and `not_found_handling`. The
component must be installed without an `httpPrefix`.

### `exposeDeploymentQuery(component)`

Returns `{ getLiveVersion }`: a public query that returns the live version's ID and activation time,
or `null`. Add this only if you use `<UpdateBanner />` or `useDeploymentUpdates`.

### `getConvexUrl()`

Browser-only. Returns `https://<deployment>.convex.cloud` when the page is served from
`<deployment>.convex.site`.

## Additional Resources

- [README](./README.md)
- [`examples/spa`](https://github.com/samebase/convex-hosting/tree/main/examples/spa): Working
  example app
- [`examples/tanstack-ssr`](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr):
  Server-rendered TanStack Start pages
- [Component source](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting/src/component)
