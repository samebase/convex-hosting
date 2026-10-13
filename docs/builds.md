# Builds: prepare, then activate

Status: proposal, revised after one Codex review. It changes how uploads publish files and how
server-rendered (SSR) releases switch. It follows the production audit in samebase/samebase PR #1712
(`research/2026-10-12-convex-hosting-production-audit.md`).

## Problem

A release has two parts, and today each part switches on its own:

- The files live in the component's storage. `publishDeployment` replaces the whole live manifest in
  one transaction.
- For SSR, the renderer is Convex code: `convex/http.ts` imports `dist/server/server.js`, so a
  functions push replaces it.

Nothing ties the two together. A release can serve renderer B with files A, or renderer A with files
B, and a failed step leaves that mix live. `deploy` makes it worse: it pushes the backend before the
upload, and a first SSR deploy can fail before the build or ship an old renderer.

The data model also has many parts. An upload writes `stagedAssets`. A publish deletes every
`staticAssets` row, inserts the new rows, copies replaced files into `retiredAssets`, and queues old
storage IDs in `pendingStorageCleanup`. `deploymentInfo` holds the current ID. Because a publish
rewrites the whole manifest in one transaction, a build is limited to 1,800 files. Cleanup runs only
during later uploads, so a retired file can stay public without an end date. The cache policy
guesses a content hash from the file name, so `sales-20261012.json` gets a one-year immutable
header.

## Proposal

A **build** is the unit of release. It is prepared in many steps, then activated in one step. A
ready build never changes, except by an explicit file removal.

| App kind | Prepare (many steps, invisible) | Activate (one step)                                                                        |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| Static   | Upload build B, mark it ready.  | One mutation sets the site's active build to B.                                            |
| SSR      | Upload build B, mark it ready.  | The functions push. Renderer B has build ID B compiled in and serves only build B's files. |

Static apps serve from the pointer. SSR apps do not: the deployed code selects its own build, so the
renderer and its files always agree. For SSR, the pointer only records the live build, for cleanup
and for the update banner.

### What builds do not solve

- Backend functions and the schema have one version for each Convex deployment. A release must keep
  the backend compatible with the previous client for as long as old tabs stay open. Changing a
  build pointer does not roll back functions or data.
- Only URLs that contain a content hash keep their old bytes for old tabs. A request from an old
  page for a stable path such as `/config.json` gets the live build's file.
- TanStack server function IDs are in both the client and server bundles. An old tab can call a
  server function that the new renderer changed or removed.

### Build identity

The build ID is random. The CLI assigns it and writes it next to the build output
(`.convex-hosting/build.json`), so a retry of the same output reuses the same ID. For SSR, the Vite
plugin assigns it during the build instead, writes the same file, and compiles the ID into the
server bundle. The server entry exports it, so `convex/http.ts` can pass it to `serveStaticAsset`.
Static apps need no plugin.

The rendered HTML carries the ID in a meta tag, which the deploy check and the update banner read.

### Data model

| Table        | Fields                                                                                                                          | Purpose                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `builds`     | `buildId`, `state` (`uploading`, `ready`, `deleting`), `expectedFiles`, `fileCount`, `spaFallback`, `createdAt`, `activatedAt?` | One row for each build. `fileCount` counts unique paths.                                                  |
| `buildFiles` | `buildId`, `path`, `storageId`, `contentType`, `sha256`, `immutable`                                                            | The files of a build. Indexes on `[buildId, path]`, `[path]`, and `[storageId]`.                          |
| `site`       | `activeBuildId`, `cleanupCursor?`                                                                                               | One row. The static pointer, the record of the live SSR build, and the storage scan position for cleanup. |

These three tables replace `staticAssets`, `stagedAssets`, `retiredAssets`, `pendingStorageCleanup`,
`cleanupState`, and `deploymentInfo`. Activation writes one row, and no step rewrites a whole
manifest.

### Upload

1. `startBuild(buildId, expectedFiles)` creates the row in state `uploading`. A repeat with the same
   arguments returns the existing row.
2. The CLI uploads each file, then registers it with `addBuildFiles(buildId, files)`. Registration
   reads the storage object's `sha256` and size from `_storage` and compares them with the values
   the CLI computed. A new path increments `fileCount`. The same path with the same digest is a
   no-op, so a retry resumes. The same path with a different digest fails.
3. `finishBuild(buildId)` compares `fileCount` with `expectedFiles` and sets `ready`. It does not
   read the files. A repeat returns the same result. A ready build rejects new files.

A file is `immutable` only when its URL contains a content hash. For an SSR build, the Vite plugin
lists the files that Vite named with `[hash]` in the asset directory. For a static build, the
operator names them with `--immutable <glob>`, which is a promise, not a guess. In both cases,
registration fails if a retained build has the same immutable path with different bytes. All other
files are revalidated with their ETag.

### Serving

`resolveAsset(path, buildId)`, where `buildId` is the renderer's own ID (SSR) or the active build
(static):

1. The file at `path` in that build.
2. Else, an `immutable` file at `path` in another build that was activated and is not `deleting`.
   Old tabs can still load their hashed scripts. Builds that never went live are never searched, and
   mutable files never fall back.
3. Else, for a page navigation (a GET whose `Accept` header includes `text/html`) in a static app
   with `spaFallback`, the build's `/index.html`. Dotted page routes work, and a missing script gets
   a real 404.
4. Else, not found.

Immutable files get `public, max-age=31536000, immutable`. Other files get `no-cache` with an ETag.
Errors keep `no-store`.

### Release

Releases for one target run one at a time. The package does not enforce this: the caller's CI does,
for example with a GitHub Actions concurrency group that also stops stale jobs before they push.
Convex accepts a push from an older job after a newer one, and no step in this package can undo it.

One target is resolved first: production, a named preview, or development. A preview request with a
production deploy key in the environment fails. `convex deploy --cmd` supplies the deployment URLs
to the build. Then:

| Step | Static                               | SSR                                                   |
| ---- | ------------------------------------ | ----------------------------------------------------- |
| 1    | Build once.                          | Build once (one build ID for client and server).      |
| 2    | Upload build B.                      | Upload build B.                                       |
| 3    | Push functions (if the app has any). | Record B as active, then push functions (renderer B). |
| 4    | Activate B.                          | Verify.                                               |
| 5    | Verify.                              |                                                       |

For SSR, the record comes before the push. If the push fails, A stays live and still has its files
(see Cleanup), and the next release fixes the record. The banner can show an update that is not live
yet during that time.

Verification fetches the site, checks the build ID in the HTML, and fetches the entry scripts and
styles. Lazy routes and server functions belong to the app's own tests.

A step can fail after a change is live: a push can succeed and its response can be lost, and
verification runs after activation. The fix is the same: run the release again. It reuses the
uploaded build.

### Cleanup

A component mutation runs every hour (it schedules its own next run, and `startBuild` restarts the
chain if it stopped). Each run does bounded work:

- Keeps the active build, the three most recently activated builds, and every build activated in the
  last seven days. For SSR, this covers both the build that was recorded and the one before it, so
  the build that the live code pins is never deleted, also when a push failed.
- Deletes an `uploading` build after one day, and a `ready` build that was never activated after
  seven days.
- To delete a build, first sets `deleting` in one mutation. Activation, registration, and the
  old-tab fallback reject a `deleting` build. Then it deletes the files and storage in batches.
- Scans `_storage` from `cleanupCursor` and deletes objects older than one day that no `buildFiles`
  row references. This covers uploads whose registration never ran.

Static rollback to a kept build is one `activateBuild` call. SSR rollback is a release of the older
commit.

`removeFile(path)` deletes the path from every build in one mutation (few builds are kept), then
cleanup deletes the storage. Browsers that cached an immutable copy keep it.

### SSR adapter

- Files are served for GET and HEAD only. Other methods, and GET requests that match no file, go to
  the renderer, so TanStack server functions work with GET and POST. Convex routes HEAD through GET.
- SSR builds do not need `index.html`.
- `server.fetch(request, opts)` passes the request context to Start, with a type.
- The rendered HTML carries the build ID meta tag. Rendering stays buffered.

### Update banner

The page knows its own build ID from the meta tag. `useDeploymentUpdates` compares it with the
site's active build, instead of with the first value it observes.

## Upgrade

This is a breaking release (0.4.0). Old sites must keep working while they upgrade:

1. The upgrade push installs the new component with the new APIs and keeps the old readers. Until a
   build is activated, `resolveAsset` serves the old `staticAssets` and `retiredAssets` rows, and
   the v1 app-storage files, exactly as today. The live site does not change.
2. The next release is the first build-based release. For SSR, if the upgrade push already contains
   the new renderer, its files are uploaded right after that push, and pages can miss their scripts
   until the upload ends. The same short window applies to a first install, because the component
   tables exist only after the first push.
3. Seven days after the first activation, the cleanup job deletes the old rows and their storage. A
   later release removes the old readers.

Sites that use the legacy convex-fs CDN option (`--cdn`) must re-upload without it before the
upgrade. Builds do not support it.

## Not in scope

- A release history UI.
- Several live renderers in one deployment, for instant SSR rollback. Convex isolates run with
  `--disallow-code-generation-from-strings`, so every renderer must be inside the pushed bundle. The
  build ID makes a later registry of recent renderers an additive change.
- Content reuse across builds.
- Streaming SSR, `Range` requests, and directory index routing.
- Edge caching. On 2026-10-12, Bristol's `*.convex.site` preview (served by 0.3.1) returned
  `public, max-age=14400` for `.js` and `.png` files whose origin header was
  `public, max-age=0, must-revalidate`, and edge-cached a 404 for a missing `.js` file. HTML and
  paths without an extension kept the origin header. The rule behind this is not documented, and
  builds cannot change it for files at stable paths.
