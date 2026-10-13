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
refers to them. There is no in-place migration.

Breaking changes:

- SPA fallback is no longer the default. Upload with `--not-found-handling single-page-application`
  for it; it serves `index.html` only to page loads, so a missing script gets a 404. `--no-spa` and
  the `spaFallback` option are gone.
- The convex-fs CDN mode (`--cdn`, `cdnBaseUrl`) and the 0.1.x app-storage fallback are gone.
- `serveStaticAsset(ctx, component, request, { exact })` looks up exact paths and has no `path` or
  `spaFallback` option; `exact: false` applies the version's routing settings. `decodeRequestPath`
  is gone.
- `UpdateBanner`, `useDeploymentUpdates`, the `./react` export, `exposeDeploymentQuery`,
  `getConvexUrl`, and the `./test` export are gone. An app reads the live version from the
  component's `lib:getLiveVersion`; the README shows how to reload a page when it changes.
- `_headers` and `_redirects` at the root of the build output are now the version's header and
  redirect rules, with Cloudflare's syntax and limits, not only files that the upload skips.
- No retention: a replaced version is never served again, so after a deploy a page that was open
  before it gets 404 for hashed files that the new version does not have, as on Cloudflare Workers.
  The hourly cleanup deletes a replaced version at its next run, a version that never went live
  after a later code push, and an unfinished upload after a day. A rollback is a redeploy from Git.
  Immutable files (`--immutable`, default `/assets/**`) of a newer, not yet live version are
  reachable for the server renderer between the code push and the switch.
- `upload` and `deploy`: `--prod`, `--build`, `--no-spa`, and `--cdn` are gone. `--component`
  defaults to `hosting`, and the CLI no longer looks for an instance named `staticHosting`. `deploy`
  needs `CONVEX_DEPLOY_KEY` or `--preview-name`. `--preview-name` needs a project's preview deploy
  key or a login, and fails next to the deploy key of one deployment (production, development, or
  one preview deployment).
- `deploy` uploads the files inside `npx convex deploy --cmd`, before the push, makes the version
  live after it, and then verifies the site.

New:

- Routing modes from Cloudflare: `--html-handling` (`auto-trailing-slash` by default) and
  `--not-found-handling` (`none`, `single-page-application`, `404-page`), stored per version.
- `.assetsignore` excludes files, as on Cloudflare.
- `--immutable <preset|glob>` with presets for Vite, Next.js, Astro, and SvelteKit. Immutable files
  get a one-year cache.
- `upload --version-id` and `--no-activate`; a rerun of the same build continues its upload.
- `deploy --build-command` and `--verify-path`. Verification fetches the `.convex.site` URL of the
  deployment and checks the ETag of `/index.html`, or the `convex-hosting-version` meta tag that
  `@samebase/convex-hosting-tanstack-start` 0.4.0 writes into server-rendered pages, and
  `lib:getLiveVersion`.
- The build output needs no `index.html`, and it can be empty.
- Limits: 4,000 files per version, 25 MiB per file, 1,024 bytes per path, and 256 KiB of rules.

## Earlier releases

See the
[changelog of 0.3.2 and earlier](https://github.com/samebase/convex-hosting/blob/8386cfaa5386eee95f6d3931c17056fa3bf27a98/packages/convex-hosting/CHANGELOG.md).
