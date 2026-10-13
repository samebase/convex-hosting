# Design: one live version, served by Cloudflare's asset worker

Status: proposal for 0.4.0, a rewrite of the component and the CLI. Revised after three Codex
reviews, a survey of Cloudflare, Netlify, Vercel, and Firebase, and the production audit in
samebase/samebase PR #1712.

## Goal

The simplest default host for a Convex app: the deployment that runs the backend also serves the
site, with no second provider. It must be a dependable option beside Cloudflare, Netlify, and Vercel
for the apps Samebase makes. It does not need feature parity with them.

## Facts the design rests on

- A Convex deployment runs one version of its functions. There is no rollback and no push history to
  restore; backups hold data and files only, and code comes back from Git
  ([backup-restore](https://docs.convex.dev/database/backup-restore)). The documented deploy order
  is backend first, then frontend
  ([custom hosting](https://docs.convex.dev/production/hosting/custom)), and functions must stay
  compatible with clients that still run the old frontend
  ([making safe changes](https://docs.convex.dev/production/overview#making-safe-changes)).
- The "missing scripts" problem that started this package's retention work had two parts
  ([get-convex/static-hosting PR 41](https://github.com/get-convex/static-hosting/pull/41)): the
  deploy order (the backend push before the file upload), and pages that were already open and lost
  their lazy scripts. Hosts handle the second part differently: Cloudflare Workers answers 404 after
  a full deploy and keeps old versions reachable only during a gradual deployment; Cloudflare Pages
  keeps cached assets after a deploy without a guarantee; Netlify and Vercel pin a whole old
  deployment by its ID.
- Cloudflare's production code for Workers Static Assets is open source (MIT or Apache-2.0):
  `packages/workers-shared/asset-worker` in
  [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/tree/main/packages/workers-shared).
  Its `handleRequest(request, env, config, exists, getByETag, analytics)` and
  `canFetch(request, env, config, exists)` are pure functions over `Request` and `Response`. PR #19
  vendors them into `packages/convex-hosting/src/workers-shared/` with a small local stub for the
  two types that the entrypoint file declares; 303 of their tests pass in this repository.
- Files uploaded through a component belong to the component's storage. An app's HTTP action cannot
  read them with its own `ctx.storage.get`
  ([components and data](https://docs.convex.dev/components/understanding#data)). The component
  returns a storage URL, and the caller fetches it, as the 0.3.x client already does.
- Convex's Cloudflare front, observed on Bristol on 2026-10-12 (not a documented rule): responses
  for paths with a static extension got a four-hour browser cache floor and edge cache hits, a 404
  for a missing `.js` file was edge-cached, HTML stayed dynamic, and bodies were gzipped.

## Model

1. **One live version per deployment.** Like a Worker, a Convex deployment serves one version of the
   site. A rollback is a redeploy from Git, the same as for Convex functions.
2. **A version owns its files.** A version is a manifest of paths with their bytes in component
   storage. A deploy uploads the version, then flips one pointer. Nothing is shared between
   versions, so deleting a version deletes its files and nothing else. Reuse of unchanged bytes
   across versions is a later optimization, when upload measurements justify a reference relation.
3. **Serving is Cloudflare's handler** with two callbacks: `exists(path)` looks up an entry of one
   version, `getByETag(hash)` returns the bytes of the entry that `exists` selected. The handler
   provides `html_handling`, `not_found_handling`, `_headers`, `_redirects`, ETag and 304, HEAD, and
   base paths, with its own tests.
4. **Immutable paths resolve across versions.** Convex cannot switch code and files in one
   operation. For paths that the upload classified as immutable, `exists` also reads the manifests
   of other `ready` versions. A new renderer finds its hashed files before the pointer flips, and a
   page that was open before a deploy still loads its lazy scripts. Stable paths never fall back.
5. **Cleanup is a cron** in the component. It needs no later upload to run.

## Data model

| Table      | Fields                                                                                                                                                                                          | Purpose                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `versions` | `versionId`, `state` (`uploading`, `ready`, `deleting`), `config` (a JSON string), `manifestSha256`, `entryCount`, `createdAt`, `liveAt?`, `supersededAt?`. Indexes on `versionId` and `state`. | One row per upload.                                       |
| `entries`  | `versionId`, `path`, `sha256`, `size`, `contentType`, `immutable`, `storageId?`. Indexes on `[versionId, path]`, `[immutable, path]`, and `storageId`.                                          | The manifest of a version. `storageId` is set per upload. |
| `site`     | `liveVersionId?`, `storageScanCursor?`.                                                                                                                                                         | One row: the pointer and the cleanup cursor.              |

`config` is a JSON string because Convex allows 1,024 fields per object and the parsed static
redirects of the asset worker are keyed by path. The parsers' own limits (100 header rules, 2,000
static and 100 dynamic redirects) keep it far below the 1 MiB document limit.

These tables replace `staticAssets`, `stagedAssets`, `retiredAssets`, `pendingStorageCleanup`,
`pendingBlobCleanup`, `cleanupState`, and `deploymentInfo`. The convex-fs CDN path and the v1
app-storage fallback go away.

## Serving

Each request selects one version once, then every lookup uses that version:

1. `getLiveVersion` returns the live version's ID and config. No live version: 404 with `no-store`.
2. The caller computes the candidate paths that the handler can probe for the request path (the path
   itself, with and without a trailing slash, with `.html`, with `/index.html`, `/index.html` and
   `/404.html` for the fallback modes) and calls `resolveMany({ versionId, paths })` once.
   `exists(path)` answers from that result; a path outside it calls `resolve`. `resolve` returns the
   version's entry, else (for an immutable path) the newest entry at that path from any `ready`
   version, else null. The result carries `sha256`, `contentType`, `immutable`, and a storage URL.
3. `getByETag(sha256)` returns the metadata of the entry that `exists` selected and a lazy body
   stream that starts `fetch(storageUrl)` on first read, so a HEAD request or a 304 downloads
   nothing. Inside the component's own route, the body comes from `ctx.storage.get`.
4. After the handler: a response with status 400 or above gets `Cache-Control: no-store` (the front
   caches 404s for static extensions, and a `_headers` rule must not make an error immutable). A 200
   or 304 for an immutable entry gets `public, max-age=31536000, immutable`. Everything else keeps
   the handler's headers: `public, max-age=0, must-revalidate` with an ETag, or the app's `_headers`
   rules.

Entry points:

- `registerStaticRoutes(http, components.hosting)`: a static app. One GET route for the prefix
  (Convex routes HEAD through GET, and the handler sees the real method). It calls `canFetch` and
  then `handleRequest`; when `canFetch` is false, it answers 404 with `no-store`. With
  `not_found_handling: "single-page-application"` the handler serves `index.html` only to navigation
  requests (`Sec-Fetch-Mode: navigate`), so a missing script gets a 404, which is the behavior of a
  Worker with assets, not of an assets-only Worker.
- `serveStaticAsset(ctx, components.hosting, request)`: an app with its own `http.ts` (server
  rendering, APIs, auth routes). It calls `canFetch` and returns `null` when it is false, so the app
  continues. Its defaults are `html_handling: "none"` and `not_found_handling: "none"`: an exact
  lookup, so `/` reaches the renderer and no `index.html` is required or served. The app can set the
  modes in its upload config when it wants them.
- Other methods never reach the handler. An app's own routes stay first in Convex's router.

Cost: one page request makes one `getLiveVersion` query, one `resolveMany` query, and one storage
read. Measure the function calls and the storage egress per request before calling this a default
for apps with traffic.

## Upload

`convex-hosting upload --dist <dir>` on a resolved target:

1. Collect the files. `.assetsignore` (gitignore syntax) and the built-in ignores apply: dot
   directories and dot files except `.well-known`, and the rule files `_headers` and `_redirects`,
   which are parsed into the version's config and not uploaded. A file above 25 MiB fails the
   upload. At most 20,000 files per version; a path at most 1,024 bytes.
2. Classify immutable paths from a setting with presets (`vite`: `/assets/**`; `next`:
   `/_next/static/**`; `astro`: `/_astro/**`; `sveltekit`: `/_app/immutable/**`) or an explicit
   glob. It is a promise by the operator, with one guard: an immutable path whose bytes differ from
   an entry at the same path in another `ready` version fails the upload. Hashes are never guessed
   from file names, and no header rule is generated for them: the serving step sets the immutable
   header from the entry.
3. Compute each file's SHA-256, size, and content type (by extension, from the vendored `mime`
   table; extensionless files in `.well-known` get `application/json`). Write the manifest as one
   JSON file (`versionId`, `config`, `entries`) and its digest. Upload it through an upload URL and
   call `startVersion({ versionId, manifestStorageId })`, an internal action: it validates the
   manifest, creates the version with `manifestSha256` and `entryCount`, writes the entries in
   batches (skipping paths that exist, so a repeat continues), and returns the entries without a
   `storageId`, at most 8,192 per call. A repeat with the same `versionId` and a different digest
   fails. A `ready` or `deleting` version fails.
4. Upload each returned entry through an upload URL and call
   `recordFile({ versionId, path, storageId })`, which checks the `sha256` and `size` that Convex
   recorded in `_storage` against the entry and sets `storageId`; a mismatch deletes the object and
   fails.
5. `finishVersion({ versionId })` checks that the entry count matches and every entry has a
   `storageId`; it sets `ready` or returns the entries that still lack one.
6. `activate({ versionId })` requires `ready`, sets the pointer, `liveAt`, and `supersededAt` on the
   old live version. Static deploys activate at once; `deploy` activates after the code push.

The `versionId` is made before the build (`v_` plus 26 base32 characters) and saved with the
manifest digest in `<dist>/.convex-hosting/version.json`. An upload reuses it when the digest
matches, so a retry continues the same version; a changed build gets a new ID. The manifest in one
file removes the argument chunking of the 0.3.x CLI.

## Deploy

`convex-hosting deploy [--build-command <cmd>] [--base-path <prefix>] [--verify-path <path>]`
resolves one target first (production, `--preview-name <name>`, or development) and passes it as an
explicit deployment selector to every step; a `--preview-name` with a production deploy key in the
environment fails. The base path (default `/`) is a CLI setting, given to the build as
`CONVEX_HOSTING_BASE_PATH` and stored in the version config. Then:

| Case                                    | Steps                                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal release (the component answers)  | `npx convex deploy --cmd "<build> && convex-hosting upload --no-activate --version-id <id>"` (the upload runs before the push, the push replaces the functions and the renderer), then `activate`, then verify.             |
| First install, or an upgrade from 0.3.x | `npx convex deploy --cmd "<build>"` (the push installs the component), then `convex-hosting upload` (which activates), then verify. The site answers 404 until the upload ends; a failed upload leaves it so until a rerun. |

Verification fetches `--verify-path` (default `/`). A static app: the ETag of `/index.html` equals
the new manifest's hash for it. A server-rendered app: the HTML carries
`<meta name="convex-hosting-version" content="<id>">` with the new ID, which the Vite plugin defines
from `CONVEX_HOSTING_VERSION_ID` at build time. Then `getLiveVersion` must name the new version.

Releases for one target run one at a time. The caller's CI enforces this, for example with a
concurrency group. Convex accepts a later push from an older job, and nothing in this package can
undo that.

Failure results: a failure before the push changes nothing live, except that the new version's
immutable files are already reachable, which is intended. A push that succeeds with an activation
that fails leaves the new renderer live with the old stable files, routing rules, and pointer; the
cleanup rule below protects that version, and a rerun of `deploy` (a new build, a new version) fixes
it. Immutable fallback protects hashed files only; a change to stable files, routing rules, or
backend APIs during a release is visible at once.

## Cleanup

An hourly cron in the component, with bounded work per run (at most 200 rows):

- Eligible for deletion: a version that is not live and was superseded more than seven days ago; an
  `uploading` version older than one day; a `ready` version that never went live, when a later
  version was activated after it was created and that activation is more than seven days old. The
  last rule protects a release whose push succeeded and whose activation failed: its renderer may be
  live, and only a later activated release proves that it is not.
- Deletion first sets `deleting` in the same transaction that checks eligibility. `activate`,
  `startVersion`, `finishVersion`, and the immutable fallback reject a `deleting` version. Then the
  entries and their storage objects go in batches, then the row.
- Storage objects older than one day that no entry references, found by a cursor scan of `_storage`
  with the `entries.storageId` index: delete them. They come from uploads whose `recordFile` call
  never ran.

Static rollback: the last activated versions stay seven days, so `activate` on one of them is a
rollback of the files. SSR rollback is a release of the older commit.

## Limits

- 25 MiB per file, 20,000 files per version, a path up to 1,024 bytes. Convex HTTP actions stop at
  100 MiB per response.
- `Range` requests get the whole body with status 200, as on Cloudflare Pages.
- `_headers`: 100 rules. `_redirects`: 2,000 static and 100 dynamic rules. The vendored parsers
  enforce them.
- `If-None-Match` with `*` or a list gets 200, as in the asset worker.
- Every file request runs a Convex HTTP action plus two queries and a storage read, and is billed as
  such, unlike a static request on Cloudflare. Edge cache hits for immutable paths reduce it.
- One backend version per deployment: an old tab talks to the new backend. Convex documents this
  compatibility rule for the app.

## Upgrade

0.4.0 is a new install. The component schema changes completely, so the upgrade push leaves the old
tables in place with their documents and starts the new tables empty; the first-install deploy
sequence above applies, and the site answers 404 until the first `activate`. Scout and Bristol
accept this. The old tables are deleted by hand afterwards. There is no in-place migration and no
support for the convex-fs CDN mode.

## Later, not in this release

- Reuse of unchanged bytes across versions (a content-addressed store with a reference relation).
- The update banner comparing the page's version meta tag with the live version.
- Streaming SSR and typed request context in the TanStack adapter.
- A `?version=` pin on the immutable lookup, if skew between tabs becomes a problem.
