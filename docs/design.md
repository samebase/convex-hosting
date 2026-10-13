# Design: one live version, served by Cloudflare's asset worker

Status: proposal for 0.4.0, a rewrite of the component and the CLI. Revised after four Codex
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
  their lazy scripts. Hosts handle the second part differently, on the production hostname:
  Cloudflare Workers answers 404 after a full deploy and keeps old versions reachable only during a
  gradual deployment or on separate version URLs; Cloudflare Pages keeps cached assets after a
  deploy without a guarantee; Netlify and Vercel pin a whole old deployment by its ID.
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

| Table            | Fields                                                                                                                                                                                          | Purpose                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `versions`       | `versionId`, `state` (`uploading`, `ready`, `deleting`), `manifestSha256`, `entryCount`, `createdAt`, `liveAt?`, `supersededAt?`, `codePushAt?`. Indexes on `versionId`, `state`, `codePushAt`. | One row per upload.                                       |
| `versionConfigs` | `versionId`, `config` (a JSON string). Index on `versionId`.                                                                                                                                    | The config of a version.                                  |
| `entries`        | `versionId`, `path`, `sha256`, `size`, `contentType`, `immutable`, `storageId?`, `ready`. Indexes on `[versionId, path]`, `[ready, immutable, path]`, and `storageId`.                          | The manifest of a version. `storageId` is set per upload. |
| `site`           | `liveVersionId?`, `versionScanCursor?`, `storageScanCursor?`.                                                                                                                                   | One row: the pointer and the cleanup cursors.             |

`config` is a JSON string because Convex allows 1,024 fields per object and the parsed static
redirects of the asset worker are keyed by path. It is at most 256 KiB. It has its own table so that
a page of 200 version rows stays far below the 16 MiB that one transaction can read.

`codePushAt` is the time of the most recent activation that came after a code push: from then on the
backend ran this version's renderer. A file-only activation never clears it. `ready` on an entry is
set in the transaction that makes its version ready, so the immutable lookup is one descending range
read on `[ready, immutable, path]` that entries of unfinished uploads never enter.

These tables replace `staticAssets`, `stagedAssets`, `retiredAssets`, `pendingStorageCleanup`,
`pendingBlobCleanup`, `cleanupState`, and `deploymentInfo`. The convex-fs CDN path and the v1
app-storage fallback go away.

## Serving

Each request is routed by one component query, `route`, so every lookup of the request reads one
version in one transaction, and the app's HTTP action does nothing but build the response:

1. The query reads the pointer and the live version. No live version: 404 with `no-store`.
2. It normalizes the version's config. `serveStaticAsset` asks for an exact lookup (`html_handling`
   and `not_found_handling` forced to `none`), so `/` reaches the app's renderer and no `index.html`
   is required. For a request that is not a navigation (`Sec-Fetch-Mode` is not `navigate`),
   `not_found_handling` is forced to `none`, so a missing script never gets the SPA page, also
   through a rewrite. Navigation detection needs the asset worker's compatibility date of 2025-04-01
   or later, which the config carries.
3. It builds the `Request` from the method, URL, and headers it received, and runs `canFetch` and
   then `handleRequest`. `exists(path)` is a per-request map over index lookups: the version's entry
   at that path, else (for a path that some entry marks immutable) the newest entry at that path
   from another `ready` version, else nothing. The key it returns is the entry's SHA-256 plus a
   short hash of its content type, so identical bytes under two content types never share one key.
   `getByETag(key)` returns that entry's content type and an empty stream that nothing reads.
4. It post-processes the headers: a status of 400 or above loses `Cache-Control`,
   `CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control`, and `Surrogate-Control` and gets
   `Cache-Control: no-store` (the front caches 404s for static extensions, and a `_headers` rule
   must not make an error cacheable). A 200 or 304 for an immutable entry gets
   `public, max-age=31536000, immutable`. Everything else keeps the handler's headers:
   `public, max-age=0, must-revalidate` with an ETag, or the app's `_headers` rules.
5. It returns `handled: false` when `canFetch` was false, else the status, the headers, and the
   selected entry (storage ID, storage URL, content type) for a 200 GET.

The HTTP action builds the `Response`. The body comes from `ctx.storage.get` inside the component's
own route, or from `fetch(storageUrl)` in the app, only when the query selected an entry for a 200
GET; a HEAD or a 304 reads no bytes.

Entry points:

- `registerStaticRoutes(http, components.hosting)`: a static app. One GET route for the prefix plus,
  for a prefix other than `/`, the exact route for the prefix without its trailing slash (Convex
  matches prefixes literally). Convex routes HEAD through GET, and the handler sees the real method.
  `handled: false` answers 404 with `no-store`. With `not_found_handling: "single-page-application"`
  the handler serves `index.html` only to navigation requests, so a missing script gets a 404: the
  behavior of a Worker with assets, not of an assets-only Worker.
- `serveStaticAsset(ctx, components.hosting, request)`: an app with its own `http.ts` (server
  rendering, APIs, auth routes). `handled: false` returns `null`, so the app continues.
- Other methods never reach the handler. An app's own routes stay first in Convex's router.

Cost: one page request makes one query and, for a 200 GET, one storage read. Measure the function
calls and the storage egress per request before calling this a default for apps with traffic.

## Upload

`convex-hosting upload --dist <dir>` on a resolved target:

1. Collect the files. `.assetsignore` (gitignore syntax) and the built-in ignores apply: dot
   directories and dot files except `.well-known`, and the rule files `_headers` and `_redirects`,
   which are parsed into the version's config and not uploaded. A file above 25 MiB fails the
   upload. At most 4,000 files per version, a path at most 1,024 bytes, and a config of at most 256
   KiB as JSON, so every version fits one Convex value and one transaction.
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
   `storageId`. A repeat with the same `versionId` and a different digest fails; a repeat on a
   `ready` version with the same digest reports `ready`, so a lost response never blocks a retry. A
   `deleting` version fails.
4. Upload each returned entry through an upload URL and call
   `recordFile({ versionId, path, storageId })`, which checks the `sha256` and `size` that Convex
   recorded in `_storage` against the entry and sets `storageId`. A mismatch deletes the object and
   returns a failure result (a thrown error would roll the deletion back). Only an `uploading`
   version accepts files.
5. `finishVersion({ versionId })` checks, in batches of 500 entries, that the entry count matches,
   every entry has a `storageId`, and no immutable path has other bytes in the newest ready version
   that has it (two uploads can start together). Then one mutation sets `ready` on the version and
   on every entry (at most 4,000 writes). Otherwise it returns the entries that still lack a file.
   Components cannot use `paginate`, so the batches use the last path as the cursor.
6. `activate({ versionId, afterCodePush })` requires `ready`, sets the pointer, `liveAt`, and
   `supersededAt` on the old live version, and sets `codePushAt` when a code push came before it,
   also when the version was live already. A plain `upload` activates at once with
   `afterCodePush: false`; `deploy` activates after the code push with `true`.

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

Verification fetches `--verify-path` (default `/`), relative to the base path. A static app: the
ETag of `/index.html` equals the new manifest's hash for it. A server-rendered app: the HTML carries
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

An hourly cron in the component starts `cleanup`, a mutation with a budget of 200 units: deleting an
entry with its object, or scanning a `_storage` object, costs 1, and deleting a version with its
config costs 8, so one call reads at most 25 configs (6.4 MiB, below the 16 MiB read limit). It
schedules itself again at once while work remains, so a large version is gone within minutes, not
hours:

- Eligible for deletion, for a version that is not live: an `uploading` version older than one day;
  a version without `codePushAt`, seven days after a later activation superseded it; a version with
  `codePushAt`, or a `ready` version that never went live, when another version has a later
  `codePushAt` (after this version's `codePushAt`, or after its `createdAt` if it never went live)
  and that `codePushAt` is more than seven days old. The backend runs the renderer of the last code
  push, and file-only activations, a rollback included, do not replace it, so the files of that
  renderer's version must stay. A never-activated version can be a release whose push succeeded and
  whose activation failed. The newest `codePushAt` that is more than seven days old comes from one
  read on its index.
- Each run checks the next 200 versions after a cursor in `site` (a `_creationTime`) and starts
  again at the oldest version when the scan ends. Components cannot use `paginate`.
- Deletion first sets `deleting` in the same transaction that checks eligibility. `activate`,
  `startVersion`, `recordFile`, `finishVersion`, and the immutable fallback reject a `deleting`
  version. Then the entries and their storage objects go in batches, then the row.
- Storage objects older than one day that no entry references, found by a scan of `_storage` by
  creation time from a cursor in `site`, with the `entries.storageId` index: delete them. They come
  from uploads whose `recordFile` call never ran.

Static rollback: the last activated versions stay seven days, so `activate` on one of them is a
rollback of the files. SSR rollback is a release of the older commit.

## Limits

- 25 MiB per file, 4,000 files per version, a path up to 1,024 bytes, a config up to 256 KiB. Convex
  HTTP actions stop at 100 MiB per response. Larger versions need pagination that this release does
  not have.
- `Range` requests get the whole body with status 200, as on Cloudflare Pages.
- `_headers`: 100 rules. `_redirects`: 2,000 static and 100 dynamic rules. The vendored parsers
  enforce them.
- `If-None-Match` with `*` or a list that contains the ETag gets 304. The asset worker compares the
  whole header with one ETag, so `route` checks the list after the handler.
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
