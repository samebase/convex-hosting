# Changelog

## 0.4.0

A rewrite of the component and the CLI around one live version per deployment, served by the code of
Cloudflare's Workers Static Assets handler.

**0.4.0 is a new install.** The component's tables are new (`versions`, `versionConfigs`, `entries`,
and `site`), so the upgrade starts with no live version: the first `deploy` pushes the backend, then
uploads, and the site answers 404 until the upload ends. The old tables (`staticAssets`,
`stagedAssets`, `retiredAssets`, `pendingStorageCleanup`, `pendingBlobCleanup`, `cleanupState`, and
`deploymentInfo`) stay with their documents until you delete them by hand in the Convex dashboard.
The hourly cleanup deletes the 0.3.x files from the component's storage, because no 0.4 version
refers to them. There is no in-place migration. See "Upgrading to 0.4" in the README.

Breaking changes:

- SPA fallback is no longer the default. Upload with `--not-found-handling single-page-application`
  for it; it serves `index.html` only to page loads, so a missing script gets a 404. `--no-spa` and
  the `spaFallback` option are gone.
- The convex-fs CDN mode (`--cdn`, `cdnBaseUrl`) and the 0.1.x app-storage fallback are gone.
- `serveStaticAsset(ctx, component, request, { exact })` looks up exact paths and has no `path` or
  `spaFallback` option; `exact: false` applies the version's routing settings. `decodeRequestPath`
  is gone.
- `exposeDeploymentQuery` returns `getLiveVersion` (`{ versionId, liveAt }` or `null`) instead of
  `getCurrentDeployment`. `UpdateBanner` and `useDeploymentUpdates` look up
  `api.hosting.getLiveVersion` and take a `getLiveVersion` reference.
- `_headers` and `_redirects` at the root of the build output are now the version's header and
  redirect rules, with Cloudflare's syntax and limits, not only files that the upload skips.
- No retention: the files of a replaced version are deleted by an hourly job, so after a deploy a
  page that was open before it gets 404 for hashed files that the new version does not have, as on
  Cloudflare Workers, and the update banner prompts the reload. A rollback is a redeploy from Git.
  Hashed files (`--immutable`, default `/assets/**`) of a newer, not yet live version are reachable
  for the server renderer between the code push and the switch.
- `upload` and `deploy`: `--prod`, `--build`, `--no-spa`, and `--cdn` are gone. `deploy` needs
  `CONVEX_DEPLOY_KEY` or `--preview-name`. `--preview-name` needs a project's preview deploy key or
  a login, and fails next to the deploy key of one deployment (production, development, or one
  preview deployment).
- `deploy` uploads the files inside `npx convex deploy --cmd`, before the push, makes the version
  live after it, and then verifies the site.

New:

- Routing modes from Cloudflare: `--html-handling` (`auto-trailing-slash` by default) and
  `--not-found-handling` (`none`, `single-page-application`, `404-page`), stored per version.
- `.assetsignore` excludes files, as on Cloudflare.
- `--immutable <preset|glob>` with presets for Vite, Next.js, Astro, and SvelteKit. Immutable files
  get a one-year cache.
- `upload --version-id` and `--no-activate`; a rerun of the same build continues its upload.
- `deploy --build-command`, `--skip-build` (which reuses the build's version ID), `--verify-path`,
  and `--site-url` for a custom domain. Verification checks the ETag of `/index.html`, or the
  `convex-hosting-version` meta tag that `@samebase/convex-hosting-tanstack-start` 0.4.0 writes into
  server-rendered pages, and `lib:getLiveVersion`.
- The build output needs no `index.html`.
- Limits: 4,000 files per version, 25 MiB per file, 1,024 bytes per path, and 256 KiB of rules.

## 0.3.2

- Responses that the package sends when no uploaded file answers (400, 404, and 500) now have
  `Cache-Control: no-store`. Before this change Cloudflare in front of `*.convex.site` cached a 404
  for a missing script for hours, even after the file was uploaded.

## 0.3.1

- `upload` and `deploy` no longer upload `_headers` and `_redirects` from the root of `dist/`.
  Cloudflare and Netlify read these files as hosting rules. Before this change the site served them
  as public files.

## 0.3.0

First release as `@samebase/convex-hosting`, Samebase's fork of `@convex-dev/static-hosting`. See
"Switching from @convex-dev/static-hosting" in the README.

- The package, the CLI command (`convex-hosting`), the component (`hosting`), the default deployment
  query module (`convex/hosting.ts`), and the `CONVEX_HOSTING_BASE_PATH` build variable share one
  name. The CLI still finds an instance named `staticHosting`.
- `serveStaticAsset` serves one uploaded file from your own HTTP route, for custom routing and
  server rendering.
- `upload --preview-name` uploads to a named preview deployment.
- Replaced files stay available for at least seven days, so pages that are already open can still
  load their scripts.
- The `setup` and `init` commands are removed. The README describes the setup steps.

Versions up to 0.2.1 were released as `@convex-dev/static-hosting`.

## 0.2.1

- Smoother migration story, with more automatic fallbacks to the old component name.

## 0.2.0

Component-owned HTTP and storage.

**Breaking — redeploy your static assets after upgrading.**

See the [0.1.x to 0.2.x migration guide](./MIGRATION.md) before upgrading an existing deployment.

- The component now hosts its own HTTP endpoints and owns the file storage that serves them. Wire it
  up with `app.use(staticHosting, { httpPrefix: "/" })` and delete related code in`convex/http.ts` +
  the upload-API re-exports from `convex/staticHosting.ts`.
- Removed `exposeUploadApi` from the client API. Uploads and file lifecycle are now handled by
  private component functions.
- `registerStaticRoutes` remains as a compatibility mode for apps that need to keep existing auth,
  webhook, or API routes at the root. It serves the new component-owned files from the app's
  existing `convex/http.ts` catch-all. During a same-name v1→v2 migration it also serves inherited
  v1 files straight from the app's own storage, so the live site stays up with no re-upload gap.
  Mounting the component's own handler is still the faster default.
- `exposeDeploymentQuery` and `getConvexUrl` remain if you use the UpdateBanner.
- The component is now named `staticHosting` (previously `selfHosting`). The CLI invokes it directly
  via `npx convex run --component staticHosting lib:...`. If you mount the component under a
  different name, pass `--component <your-name>`. For a smooth upgrade, pass {name: "selfHosting} to
  `app.use(staticHosting, { name: "selfHosting" })`
- `useDeploymentUpdates` / `UpdateBanner` use `useQuery_experimental` and default to
  `api.staticHosting.getCurrentDeployment`. If you don't surface deployment updates, you no longer
  need to expose anything.
- Assets uploaded under 0.1.x lived in the app's storage — the component-owned HTTP handler can't
  resolve those references in 0.2.x. Run `npx @convex-dev/static-hosting deploy` to repopulate. (In
  app-owned root routing the app-side handler keeps serving those v1 files from app storage until
  the first upload replaces them, so that mode has no asset-less window.) The first 0.2.x upload
  safely discards those legacy storage references instead of trying to delete them from component
  storage. The old blobs remain in app storage until you explicitly clean them up after the rollback
  window. Older 0.1.x deploys may also have left historical blobs that the current asset manifest no
  longer lists, so follow the migration guide's app-storage audit before cleanup.
- Default setup prefixes your own HTTP routes with `defineApp({ httpPrefix: "/api" })` so the static
  site can own the root without the catch-all route shadowing them. Use `registerStaticRoutes` when
  those existing root route URLs cannot move.
- SPA fallback is now configurable per deployment. Deploy with `--no-spa` (`deploy` or `upload`) to
  make extension-less misses return 404 instead of `index.html`. The setting is stored on the
  deployment record, so it travels with the code you ship.
- Hashed-asset caching recognizes Vite's base64url hashes (including `-`) and numeric extensions
  such as `.woff2`. HTML always uses revalidation, even if its filename looks content-hashed.
- The `cdnBaseUrl` override remains available in `registerStaticRoutes` compatibility mode.
  Component-owned HTTP routes redirect CDN blobs to the deployment's own `{origin}/fs/blobs`.
- `--cdn` is now documented as a legacy option. Its setup guide targeted an old unauthenticated
  convex-fs API and does not work with current ConvexFS. New integrations should use Convex storage
  until authenticated CDN uploads are designed.
- Storage and legacy CDN assets, deployment settings, and old-file cleanup are published in one
  atomic mutation after all uploads finish. New HTML cannot race ahead of its referenced asset
  records, and a failed publish leaves the previous deployment live. Replaced CDN blob IDs are
  retained for cleanup.
- Upload errors now report the failing file and HTTP status. Oversized manifests fail with a clear
  size error, and newly uploaded component files are removed after a failed upload or publish.
- Static handlers decode percent-encoded paths, accept weak or listed ETags, and return a
  non-cacheable HTTP 503 setup page until the first upload succeeds.
- Removed the install-time console banner.

## 0.1.5

- Forward-compatibility for 0.2.x rollbacks. The `deploymentInfo` schema and the
  `getCurrentDeployment` return validator now allow the optional `spaFallback` (boolean) and
  `pendingBlobCleanupCount` (number) fields that 0.2.x writes to the deployment record. 0.1.5
  ignores them, but allowing them means a deployment upgraded to 0.2.x and later rolled back to
  0.1.x keeps validating. No behavior change for 0.1.x users; upgrade to 0.1.5 before trying 0.2.x
  if you want a clean rollback path. (0.2.x also creates additional tables such as `stagedAssets`
  and `cleanupState`; extra tables don't fail 0.1.x schema validation, so they need no entry here.)

## 0.1.4

- Added support for Windows

## 0.1.3

- Fix missing README in published package

## 0.1.2

- Rename package from `@convex-dev/self-hosting` to `@convex-dev/static-hosting`

## 0.1.1-alpha.0

- Add optional convex-fs CDN mode for static asset serving (`--cdn` flag)
- Non-HTML assets can be served from CDN edge network via convex-fs
- New `cdnBaseUrl` option on `registerStaticRoutes`
- Schema: `storageId` now optional, new `blobId` field for CDN assets
- `gcOldAssets` returns `{ deleted, blobIds }` (breaking change from number return)

## 0.1.2-alpha.1

removed cloudflare for now.

## 0.1.1

- Setup wizard now configures custom domains for Cloudflare Workers
- Added note about running `convex dev` for HTTP actions error
- Added documentation for non-Vite bundlers (Expo, Next.js)

## 0.1.0

- Migrated from Cloudflare Pages to Workers Static Assets

## 0.0.0

- Initial release.
