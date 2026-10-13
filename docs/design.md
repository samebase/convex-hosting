# convex-hosting 0.4: design

A Convex deployment serves the app's site: the files of a build and, when the app renders pages,
those pages. It behaves like Cloudflare Workers with static assets, so a developer who knows that
model learns nothing new: the same files (`_headers`, `_redirects`, `.assetsignore`), the same two
options (`html_handling`, `not_found_handling`), the same responses, computed by Cloudflare's own
asset-serving code. One command deploys. No old version is ever served.

This document is the proposal. Every file, function, option, and table field in the package must
trace to a line here. Nothing exists for compatibility with earlier releases or with
get-convex/static-hosting.

## The model

On Cloudflare, `wrangler deploy` uploads the asset files and the Worker code as one version. The
Worker is bound to the assets it was deployed with, so the switch is atomic, and old versions are
gone from the production hostname.

On Convex, two systems hold the two halves: `npx convex deploy` pushes the app code, and the site
files live in a component's storage. The design binds them the way Cloudflare does: the pushed code
carries the id of the asset version it was built with, and asks the component for exactly that
version. The push is the switch. There is no pointer that a second step must move, so there is no
moment when new code serves old files.

Only the pushed code knows which version a deployment runs, so the serving code reports it: the
first request that new code serves finds its version in state `ready` and marks it `live`. An hourly
pass then deletes what nothing can reference any more: every version that was live before the
current one, and every version that is not live and is older than one hour. The hour is the time an
upload has to be pushed. It exists because a version that has finished uploading may belong to a
deploy whose push has not landed yet, and no request can tell that version from an abandoned one.
Nothing in this hour is served: the code names one version, and that is the only one that answers.

## Deploy

```
convex-hosting deploy --build "<command>" --dist <dir> [--html-handling ...] [--not-found-handling ...] [--preview-name <name>]
```

Every Convex call of one deploy reaches one deployment. A deploy key in `CONVEX_DEPLOY_KEY` (from
the environment or `.env.local`) selects it for both `npx convex deploy` and `npx convex run`;
`--preview-name` is passed to both and needs a login or a project's preview deploy key; without
either, `npx convex deploy` goes to production, so `npx convex run` gets `--prod`. A deployment's own
deploy key and `--preview-name` together are an error, because the Convex CLI would ignore the name.

1. The CLI chooses a random version id.
2. It runs `npx convex deploy --cmd "<command> && convex-hosting upload --dist <dir> --version-id <id> ..."`.
   Convex gives the build the deployment's URL in `CONVEX_URL` and in one framework variable such as
   `VITE_CONVEX_URL`, as it documents for frontends. Inside the command, `upload`:
   1. collects the files of `<dir>`, honoring `.assetsignore`, and computes each file's sha256,
      size, and content type; reads `_headers` and `_redirects` with Cloudflare's parsers into the
      version's config;
   2. stores the manifest (the config and the entries) as one file through an upload URL, because
      `npx convex run` passes arguments on the command line, which the operating system limits,
      and a manifest can be megabytes; (`npx convex run` stays the transport because it handles
      every way a deployment is selected: login, deploy keys, previews by name;)
   3. calls `startVersion` with the manifest's storage id. The component creates the version in
      state `uploading` and its entries, in batches that fit Convex's transaction limits, and gives
      each entry whose sha256 a recorded entry already has that entry's stored file;
   4. loops: asks for a page of entries without a file, gets upload URLs for them, uploads the
      files a few at a time, and records them with `recordFiles`, which checks each file's sha256
      and size against Convex's storage metadata; the loop ends when no entry is without a file;
   5. calls `finishVersion`, which puts the version in state `ready` when no entry is without a
      file;
   6. writes `convex/hostingVersion.generated.ts` with the id. The two dots keep Convex from treating
      the file as a function module; it is bundled as an import of `http.ts`.
   Then, still inside `npx convex deploy`, Convex bundles `convex/` with the new id and pushes. The
   push is the switch.

That is the whole command. The hourly pass deletes the previous version.

**First install.** The component's functions exist only after a push, and a new preview deployment
exists only once `npx convex deploy` has created it, which happens before it runs the command. So
the inner `upload` decides: when its first call answers with the Convex CLI's exact message
`Component path "<name>" was not found.`, it writes the version file and a marker file in `<dir>`
and exits without uploading, so the push that follows installs the component. `deploy` sees the
marker after `npx convex deploy` returns and runs the upload then. Until that upload ends, the site
answers 404 (see Serve). This happens once per deployment.

**Development deployment.** `npx convex deploy` targets production or a preview. For the
development deployment the developer runs `npx convex dev`, which pushes on every change to the
bundle's inputs, and uploads with the build of their choice:

```
vite build && convex-hosting upload --dist dist
```

`upload` writes the version file last, and the running `npx convex dev` pushes it. On a fresh
clone, the version file does not exist (it is ignored by git), so `npx convex dev` cannot bundle
`convex/http.ts`, and the component is not pushed, so `upload` cannot store files. `upload`
resolves this itself: when its first call answers with the missing-component message, it writes the
version file first, which lets `npx convex dev` push, and retries that call every few seconds for
two minutes before it gives up with the error. During such an upload the site answers 404.

Two things in this loop are transient and documented, not solved: when a server-rendered app's build
changes `dist/server`, which `http.ts` imports, `npx convex dev` pushes before `upload` has written
the new id, so pages reference files that answer 404 until the upload ends; and a production deploy
run from the same checkout writes production's id, which `npx convex dev` then pushes to the
development deployment, where that version does not exist, until the next `upload`. Production
deploys belong in CI or a separate checkout.

**Two deploys at once** behave like two Convex pushes: the one whose push lands last serves. Its
version became `ready` less than an hour before, so the pass has not deleted it; the other
version is deleted as soon as the pass sees that it is not the current one.

**Failures.** A deploy that dies before the push leaves a version that nothing serves; the pass
deletes it an hour later. An upload that dies leaves a version in state `uploading`; the next upload
reuses every file it recorded, and the pass deletes the version an hour later. A file stored but
never recorded, or a manifest, has no entry; the pass also deletes files in Convex's `_storage`
table that no entry references and that are older than one hour, the same grace an upload gets. A
push that the command reports as failed may still have landed; the site then serves the new version,
and the next deploy is a normal one. No resume logic.

**Browsers.** A page opened before a deploy keeps asking for its hashed files, which now answer
404, exactly as on Cloudflare. An app that wants to reload on a new version adds one query that
returns the bundled `versionId` and reloads when its value changes. The README shows it. The
component has no part in it.

## Serve

The app's `convex/http.ts` has one route, `GET` with `pathPrefix: "/"`. Convex answers `HEAD`
through the `GET` handler and drops the body. Other methods are the app's own routes, as on
Cloudflare a `POST` goes to the Worker.

```ts
import { serveAsset } from "@samebase/convex-hosting";
import { versionId } from "./hostingVersion.generated.js";

const asset = await serveAsset(ctx, components.hosting, request, versionId);
if (asset) return asset;
// A static site: 404. A server-rendered site: render the page.
```

`serveAsset` calls the component query `route` with the method, the URL, and the request headers
that Cloudflare's handler reads. Inside the query, Cloudflare's `canFetch` decides whether an asset
answers. The app is the Worker, so Cloudflare's routing with a Worker applies: a request that does
not resolve to a file goes to the app, and `not_found_handling` (the 404 page, the single-page
fallback) applies to navigation requests only. Two differences from Cloudflare follow from Convex's
router and are stated, not fixed: an exact app route wins over an asset at the same path, and a
static site's non-navigation miss (`curl /missing`) answers 404 instead of the single-page fallback.
The component runs the handler with a fixed compatibility date at or after 2025-04-01, the date from
which Cloudflare treats `Sec-Fetch-Mode: navigate` requests this way; the date is package code, not
configuration. When an asset answers, Cloudflare's `handleRequest` computes the status and headers:
`Cache-Control: public, max-age=0, must-revalidate` (Cloudflare omits it when the request carries
`Authorization` or `Range`, and so do we), `ETag`, 304 for `If-None-Match`, `_headers` rules,
`_redirects`, `html_handling`, and the custom 404 page with its body. The query drops
`CF-Cache-Status`, which describes a cache we do not run, and returns the status, the headers, and
the storage URL of the body when the response has one, whatever the status. `serveAsset` fetches
that body and returns the response. When storage answers 404, because the pass deleted the file
between the query and the fetch, the answer is 404; any other fetch failure answers 502 with no
caching. An app cannot read a component's storage, so each asset hit costs that one fetch.

When the version does not exist or is still `uploading`, `serveAsset` returns a 404 response that
names the version, so a half-installed site answers 404 rather than rendering pages without their
files. `null` means one thing: no asset matched, and the app continues.

The two callbacks that Cloudflare's code takes map to the version's entries: `exists(path)` reads
one index entry and returns its ETag, the sha256 followed by a short hash of the content type, so
that identical bytes stored under two content types stay distinct; `getByETag` returns the content
type of the entry that `exists` found and a placeholder stream, which `serveAsset` replaces with the
body. Nothing is added to Cloudflare's headers. Long caching of hashed files is a `_headers` rule,
as on Cloudflare.

When `route` finds the version in state `ready`, it says so, and `serveAsset` calls `markLive`;
concurrent first requests all call it, and it is idempotent.

Other HTTP routes of the app (auth, APIs) win over the site route when they are exact paths or
longer prefixes, by Convex's router rules for the same method.

## Component

Two tables.

| Table      | Fields                                                                                         | Indexes                                        |
| ---------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `versions` | `versionId`, `state` (`uploading`, `ready`, `live`), `liveAt` (set with `live`), `config` (JSON string) | `by_versionId`, `by_state`                     |
| `entries`  | `versionId`, `path`, `sha256` (hex), `size`, `contentType`, `storageId` (absent until recorded) | `by_version_path`, `by_sha256`, `by_storageId`, and one that finds a version's entries without a file |

Creation times come from `_creationTime`. `config` is the JSON of Cloudflare's `AssetConfig` for the
version: `html_handling`, `not_found_handling`, `headers`, `redirects`. It is a string because
`redirects.staticRules` has one field per rule and Convex limits an object to 1,024 fields. A
document is limited to 1 MiB, so the CLI refuses a config above 900 KiB, leaving room for the other
fields and the encoding, and names the file that causes it; Cloudflare's own rule limits (100 header
rules, 2,000 static and 100 dynamic redirects) fit unless paths are very long.

Functions. The CLI calls the internal ones with `npx convex run --component`; `serveAsset` calls the
two public ones through the component reference (an app can call only a component's public
functions, and clients cannot call them at all).

| Function             | Kind              | Does                                                                                                       |
| -------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `generateUploadUrls` | internal mutation | Returns `count` upload URLs.                                                                               |
| `startVersion`       | internal action   | Reads the manifest from storage and, through internal mutations in batches, creates the version and its entries, reusing recorded files by sha256. Idempotent for the same id and manifest. |
| `missingEntries`     | internal query    | Returns one page of the version's entries without a file.                                                  |
| `recordFiles`        | internal mutation | Attaches stored files to entries after checking sha256 and size.                                           |
| `finishVersion`      | internal mutation | Marks the version `ready` when it finds no entry without a file; otherwise says that one exists.           |
| `route`              | public query      | Runs Cloudflare's `canFetch` and `handleRequest` for one request against one version; reports the version's state. |
| `markLive`           | public mutation   | Marks a `ready` version `live` with `liveAt`.                                                              |
| `collectGarbage`     | internal mutation | The hourly pass, from `crons.ts`: deletes live versions other than the one with the latest `liveAt`, non-live versions older than one hour, their entries, and the stored files no remaining entry uses; then `_storage` files older than one hour that no entry references. One batch per call; it schedules itself with `runAfter(0)` while work remains; a failed batch is retried by the next hour's run. |

The package sets no limits of its own. Convex's limits apply: 1 MiB per document, and the
transaction limits (16,000 writes, 32,000 documents scanned, 16 MiB read and written, 8,192 array
elements, 4,096 index ranges, argument and result sizes) shape the batches.

## Not here, and why

- No live pointer that a command moves, no `activate`, no `getLiveVersion`: the pushed code names its
  version, and the serving code reports it.
- No retention: nothing old is served. The one-hour grace is the time an upload has to be pushed,
  and the hourly pass is the one place that deletes, so a failed batch is retried.
- No marking of hashed files, no one-year `Cache-Control`: Cloudflare has neither. A site that wants
  them writes one `_headers` rule.
- No component HTTP route, no `httpPrefix` mount, no second serving helper: one way for static and
  server-rendered sites. A component route could not hand a request to the app's renderer.
- No post-deploy verification, no version meta tag: `wrangler deploy` has none. The push succeeds or
  fails.
- No base path: the site is served at the origin root.
- No compatibility date per version: it is package code.
- No React code: the reload recipe is an app query.
- No migration from 0.3.x: 0.4 is a new install. The old tables are deleted by hand.

## Repository

- `packages/convex-hosting`
  - `src/component`: `schema.ts`, `lib.ts`, `crons.ts`, `convex.config.ts`, and its generated files.
  - `src/client`: `serveAsset`.
  - `src/cli`: the `convex-hosting` command: `deploy` and `upload`.
  - `src/workers-shared`: Cloudflare's asset worker and its tests, copied by
    `scripts/sync-workers-shared.ts` from cloudflare/workers-sdk at the commit in `UPSTREAM`. Only
    the sync script changes it.
  - Whatever `npx convex codegen --component-dir ./src/component` needs to run against an anonymous
    local deployment, and nothing more; `CONTRIBUTING.md` says what that is. No example is involved.
- `packages/convex-hosting-tanstack-start`: the Vite settings and the server entry that make
  TanStack Start's server build run inside a Convex HTTP action (Convex cannot bundle
  `node:stream`, so pages render with React's Web Stream renderer). It knows nothing about versions.
- `examples/spa`: a Vite app served with `--not-found-handling single-page-application`.
- `examples/tanstack-ssr`: pages rendered in the app's HTTP action after `serveAsset`.
- One `README.md` at the repository root, copied into the package at `prepack`.
