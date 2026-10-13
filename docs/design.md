# Design: one live version, served by Cloudflare's asset worker

Status: proposal for 0.4.0, a rewrite of the component and the CLI. It replaces the earlier "builds"
draft after two Codex reviews, a survey of Cloudflare, Netlify, Vercel, and Firebase, and the
production audit in samebase/samebase PR #1712.

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
- No host serves old hashed files at the production URL after a deploy. Cloudflare Workers answers
  404; Netlify and Vercel pin a whole old deployment by its ID instead. The "missing scripts"
  problem that started this package's retention work came from the deploy order (the backend push
  before the file upload), not from open tabs
  ([get-convex/static-hosting PR 41](https://github.com/get-convex/static-hosting/pull/41)).
- Cloudflare's production code for Workers Static Assets is open source (MIT or Apache-2.0):
  `packages/workers-shared/asset-worker` in
  [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/tree/main/packages/workers-shared).
  Its `handleRequest(request, env, config, exists, getByETag, analytics)` is a pure function over
  `Request` and `Response`. On 2026-10-13, 294 of its tests passed in plain Node with no code change
  (handler 193, rules engine 11, `_headers` and `_redirects` parsers 53, base path 21, others 16).
  Only one test file needs workerd.
- Convex's Cloudflare front, measured on Bristol on 2026-10-12: responses for paths with a static
  extension get a four-hour browser cache floor and edge cache hits; HTML stays dynamic; bodies are
  gzipped. The rule is not documented, and this package cannot change it.

## Model

1. **One live version per deployment.** Like a Worker, a Convex deployment serves one version of the
   site. A rollback is a redeploy from Git, the same as for Convex functions.
2. **A version is a manifest.** It maps each path to the SHA-256 of its bytes. The bytes live in one
   content-addressed store that all versions share. A deploy uploads only the hashes the store does
   not have, writes the manifest, and flips one pointer. Unchanged files are never uploaded twice,
   and the switch is one write.
3. **Serving is Cloudflare's handler** with two callbacks: `exists(path)` reads the live manifest,
   `getByETag(hash)` reads Convex storage. The handler provides `html_handling`,
   `not_found_handling` (with navigation detection), `_headers`, `_redirects`, ETag and 304, HEAD,
   and base paths, with its own tests.
4. **One deviation, for server rendering.** Convex cannot switch code and files in one operation. If
   `exists` read only the live manifest, a new renderer would ask for its hashed files before the
   pointer flips and get 404 for a few seconds. So for paths configured as immutable, `exists` also
   reads the manifests of recent versions. This makes the order of the code push and the pointer
   flip irrelevant. Open tabs keep loading their old scripts as a side effect.
5. **Cleanup is a cron** in the component. It needs no later upload to run.

## Data model

| Table      | Fields                                                                                                             | Purpose                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `files`    | `sha256`, `storageId`, `size`. Index on `sha256`.                                                                  | The content-addressed store, shared by all versions.                   |
| `versions` | `versionId`, `state` (`uploading`, `ready`), `config`, `createdAt`, `liveAt?`, `supersededAt?`.                    | One row per upload. `config` holds the parsed rules and routing modes. |
| `entries`  | `versionId`, `path`, `sha256`, `contentType`, `immutable`. Indexes on `[versionId, path]` and `[immutable, path]`. | The manifest of a version.                                             |
| `site`     | `liveVersionId`.                                                                                                   | One row: the pointer.                                                  |

`exists(path)`: the live version's entry, else (for `immutable` entries only) the newest entry at
that path from a version that is `ready`. `getByETag(sha256)`: the `files` row, then
`ctx.storage.get`. One request makes one query for the entry and one for the file. These tables
replace `staticAssets`, `stagedAssets`, `retiredAssets`, `pendingStorageCleanup`,
`pendingBlobCleanup`, `cleanupState`, and `deploymentInfo`. The convex-fs CDN path and the v1
app-storage fallback go away.

## Vendored code

`packages/convex-hosting/src/workers-shared/` holds a copy of the handler, `configuration.ts`,
`compatibility-flags.ts`, `utils/{headers,base-path,rules-engine}.ts`, the shared `responses.ts`,
`tracing.ts` (the mock binding only), `types.ts`, and the `_headers`, `_redirects`, and
`.assetsignore` parsers for the CLI, with their tests. Not copied: the worker entrypoint, KV,
analytics, cohorts, and Sentry; the handler gets a no-op analytics object and the mock tracing
binding. `scripts/sync-workers-shared.ts` refreshes the folder from a pinned upstream commit, an
`UPSTREAM` file records the commit, NOTICE records the license, and the folder is excluded from
oxfmt and oxlint so a sync is a clean diff. It lives inside the package, not as a workspace package,
because the published package must contain it.

## Serving entry points

- `registerStaticRoutes(http, components.hosting)`: a static app. One GET and HEAD route for the
  whole prefix calls `handleRequest` with the live version's config. Convex routes HEAD through GET
  and the handler sees the real method.
- `serveStaticAsset(ctx, components.hosting, request)`: an app with its own `http.ts` (server
  rendering, APIs, auth routes). It calls `canFetch` and then `handleRequest`, and returns `null`
  when the asset worker would not answer, so the app continues. Such an app uses
  `not_found_handling: "none"`, so page misses reach its renderer, exactly as a Worker with assets
  does.
- Other methods never reach the handler. An app's own routes stay first in Convex's router.

Response headers come from the handler: `public, max-age=0, must-revalidate` with an ETag by
default; `_headers` rules override them. The CLI writes one rule for the immutable paths
(`public, max-age=31536000, immutable`). Errors keep `no-store`, because the front caches 404s for
static extensions.

## Upload

`convex-hosting upload --dist <dir>` on a resolved target:

1. Collect the files. `.assetsignore` (gitignore syntax) and the built-in ignores apply: dot
   directories and dot files except `.well-known`, and the rule files `_headers` and `_redirects`,
   which are parsed into the version's config. A file above 25 MiB fails the upload.
2. Classify immutable paths from a setting with presets (`vite`: `/assets/**`; `next`:
   `/_next/static/**`; `astro`: `/_astro/**`; `sveltekit`: `/_app/immutable/**`) or an explicit
   glob. It is a promise by the operator, with one guard: an immutable path whose bytes differ from
   an existing entry at the same path fails the upload. Hashes are never guessed from file names.
3. Compute each file's SHA-256 and content type (by extension, from one table that includes `wasm`,
   `pdf`, video, and audio types; extensionless files in `.well-known` get `application/json`).
   Write the manifest as one JSON file, upload it through an upload URL, and call
   `startVersion({ versionId, manifestStorageId })`, an internal action. It validates the manifest
   against Cloudflare's rule limits, writes the entries in batches, and returns the hashes that
   `files` does not have. A repeat with the same `versionId` returns the same answer.
4. Upload each missing file through an upload URL and call `recordFile({ sha256, storageId })`,
   which checks the digest and size that Convex recorded in `_storage` and rejects a mismatch.
5. `finishVersion({ versionId })` checks that every entry's hash is in `files` and sets `ready`.
6. `activate({ versionId })` sets the pointer and `supersededAt` on the old live version. Static
   deploys do this at once; `deploy` does it after the code push. A `ready` version is the only kind
   that can be activated.

The manifest in one file removes the argument chunking that the current CLI needs. A retry reuses
`versionId` from `.convex-hosting/version.json` next to the build output.

## Deploy

`convex-hosting deploy` resolves one target first: production, `--preview-name <name>`, or
development. A `--preview-name` with a production deploy key in the environment fails. Then it runs
`npx convex deploy --cmd "<build> && convex-hosting upload --version-id <id>"`, which gives the
build the deployment URLs, uploads the version before the push, and pushes the functions. After the
push, `deploy` activates the version and verifies: for a static app, the ETag of `/index.html`
equals the new manifest's hash; for a server-rendered app, `/` returns 200 and references an
immutable path of the new manifest.

Releases for one target run one at a time. The caller's CI enforces this, for example with a
concurrency group. Convex accepts a later push from an older job, and nothing in this package can
undo that.

Failure results: before the push, nothing changed. A push that succeeds and an activation that fails
leaves the new renderer live with the old stable files; a rerun fixes it, and the new version stays
for seven days. The first install is the one deploy where the renderer can go live before its files
exist, because the component tables appear with the first push; nothing is live yet, so no page
breaks.

## Cleanup

An hourly cron in the component, with bounded work per run:

- A version that is not live and was superseded more than seven days ago, an `uploading` version
  older than one day, or a `ready` version that never went live and is older than seven days: delete
  its entries in batches, then the row.
- A `files` row whose hash has no entry, found by a cursor scan: delete the storage object and the
  row.
- Storage objects older than one day that no `files` row references, found by a cursor scan of
  `_storage`: delete them. They come from uploads whose `recordFile` call never ran.

The live version is never deleted, because the pointer flips only after a push succeeds. A version
whose push succeeded but whose activation failed stays `ready` for seven days, which is the time to
rerun the deploy.

## Limits

- 25 MiB per file, the Cloudflare limit. Convex HTTP actions stop at 100 MiB per response.
- `Range` requests get the whole body with status 200, as on Cloudflare Pages.
- `_headers`: 100 rules. `_redirects`: 2,000 static and 100 dynamic rules. The vendored parsers
  enforce them.
- Every file request runs a Convex HTTP action and is billed as one, unlike a static request on
  Cloudflare. Edge cache hits for immutable paths reduce it. Measure before calling this a default
  for apps with traffic.
- One backend version per deployment: an old tab talks to the new backend. Convex documents this
  compatibility rule for the app.

## Upgrade

0.4.0 is a new install. The component schema changes completely, so the upgrade push leaves the old
tables in place with their documents and starts the new tables empty. The site answers 404 between
that push and the first `activate`, about one minute in CI. Scout and Bristol accept this. The old
tables are deleted by hand afterwards. There is no in-place migration and no support for the
convex-fs CDN mode.

## Later, not in this release

- A version meta tag in HTML, so the update banner compares the page's version with the live one
  instead of the first value it observes.
- Streaming SSR and typed request context in the TanStack adapter.
- Reuse of the hashed-asset lookup for a `?version=` pin, if skew between tabs becomes a problem.
