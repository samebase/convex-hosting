# convex-hosting 0.4: design

A Convex deployment serves the app's site: the files of a build and, when the app renders pages,
those pages. It behaves like Cloudflare Workers with static assets, so a developer who knows that
model learns nothing new: the same files (`_headers`, `_redirects`, `.assetsignore`), the same two
options (`html_handling`, `not_found_handling`), the same responses, computed by Cloudflare's own
asset-serving code. One command deploys. Nothing of an old version stays.

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

The switch registers itself. The first request that the new code serves finds its version in state
`ready`, marks it `live`, and the component then deletes every version created before it. No command
and no schedule decides what is old: the serving code does, because it is the only thing that knows
which version the deployment runs.

## Deploy

```
convex-hosting deploy --build "<command>" --dist <dir> [--html-handling ...] [--not-found-handling ...] [--preview-name <name>]
```

`deploy` needs a deploy key (`CONVEX_DEPLOY_KEY`, from the environment or `.env.local`) or
`--preview-name`, because `npx convex deploy` pushes to production by default while `npx convex run`
without a key uses the development deployment. Every Convex call of one deploy gets the same
selector, so the upload, the push, and the first-install check reach one deployment.

1. The CLI chooses a random version id.
2. It runs `npx convex deploy --cmd "<command> && convex-hosting upload --dist <dir> --version-id <id> ..."`.
   Convex gives the build the deployment's URL variables (`CONVEX_URL`, `VITE_CONVEX_URL`, and the
   other framework prefixes), as it documents for frontends. Inside the command, `upload`:
   1. collects the files of `<dir>`, honoring `.assetsignore`, and computes each file's sha256,
      size, and content type; reads `_headers` and `_redirects` with Cloudflare's parsers into the
      version's config;
   2. stores the manifest (the config and the entries) as one file through an upload URL, because
      `npx convex run` passes arguments on the command line, which the operating system limits,
      and a manifest can be megabytes;
   3. calls `startVersion` with the manifest's storage id. The component creates the version in
      state `uploading` and its entries, in batches that fit Convex's transaction limits, and gives
      each entry whose sha256 a recorded entry already has that entry's stored file;
   4. loops: asks for a page of entries without a file, gets upload URLs for them, uploads the
      files a few at a time, and records them with `recordFiles`, which checks each file's sha256
      and size against Convex's storage metadata; the loop ends when no entry is without a file;
   5. calls `finishVersion`, which puts the version in state `ready`;
   6. writes `convex/hostingVersion.ts` with the id.
   Then, still inside `npx convex deploy`, Convex bundles `convex/` with the new id and pushes. The
   push is the switch.

That is the whole command. Deletion of older versions happens when the new version serves its first
request (see The model).

**First install.** The component's functions exist only after a push. `deploy` calls one component
function first. When the Convex CLI answers that the component does not exist (that exact error,
not any failure), `deploy` writes the version file, runs `npx convex deploy --cmd "<command>"` (the
build must run before this push too, because a server-rendered app's `http.ts` imports its server
build), and then uploads. The site answers 404 until that upload ends. This happens once per
deployment.

**Development deployment.** `npx convex deploy` targets production or a preview. For the
development deployment the developer runs `npx convex dev`, which pushes on every change in
`convex/`, and uploads with the build of their choice:

```
vite build && convex-hosting upload --dist dist
```

`upload` writes the version file last, and the running `npx convex dev` pushes it. On a fresh
clone, `convex/hostingVersion.ts` does not exist (it is ignored by git), so `npx convex dev` cannot
bundle `convex/http.ts`, and the component is not pushed, so `upload` cannot store files. `upload`
resolves this itself: when the component does not answer, it writes the version file first, which
lets `npx convex dev` push, and retries its first call every few seconds for two minutes before it
gives up with the error. During such an upload the site answers 404.

**Concurrent deploys** are not supported, as two `npx convex deploy` runs are not. What happens: the
version whose code lands last serves and becomes live; any version created before it, even one
still uploading, is deleted, and that other deploy fails at its next call.

**Failures.** A deploy that dies before the push leaves a version that nothing serves; it is deleted
when a later version goes live. An upload that dies leaves a version in state `uploading`; the next
upload reuses every file it recorded, and the version is deleted the same way. A file stored but
never recorded has no entry; the deletion pass also sweeps Convex's `_storage` table for files that
no entry references. No resume logic.

**Browsers.** A page opened before a deploy keeps asking for its hashed files, which now answer
404, exactly as on Cloudflare. An app that wants to reload on a new version adds one query that
returns the bundled `versionId` and reloads when its value changes. The README shows it. The
component has no part in it.

## Serve

The app's `convex/http.ts` has one route, `GET` with `pathPrefix: "/"`. Convex answers `HEAD`
through the `GET` handler and drops the body. Other methods are the app's own routes.

```ts
import { serveAsset } from "@samebase/convex-hosting";
import { versionId } from "./hostingVersion.js";

const asset = await serveAsset(ctx, components.hosting, request, versionId);
if (asset) return asset;
// A static site: 404. A server-rendered site: render the page.
```

`serveAsset` calls the component query `route` with the method, the URL, and the request headers
that Cloudflare's handler reads. Inside the query, Cloudflare's `canFetch` decides whether an asset
answers. The app is the Worker, so Cloudflare's routing with a Worker applies: a request that does
not resolve to a file goes to the app, and `not_found_handling` (the 404 page, the single-page
fallback) applies to navigation requests only. The component runs the handler with a fixed
compatibility date at or after 2025-04-01, the date from which Cloudflare treats
`Sec-Fetch-Mode: navigate` requests this way; the date is package code, not configuration. When an
asset answers, Cloudflare's `handleRequest` computes the status and headers: `Cache-Control: public,
max-age=0, must-revalidate` (Cloudflare omits it when the request carries `Authorization` or
`Range`, and so do we), `ETag`, 304 for `If-None-Match`, `_headers` rules, `_redirects`,
`html_handling`. The query drops `CF-Cache-Status`, which describes a cache we do not run, and
returns the status, the headers, and the storage URL of the body when the response has one.
`serveAsset` fetches the body only for a 200 that carries one, and returns the response. When that
fetch fails, because a deletion pass removed the file between the query and the fetch, the answer
is 404. An app cannot read a component's storage, so each asset hit costs that one fetch.

The two callbacks that Cloudflare's code takes map to the version's entries: `exists(path)` reads
one index entry and returns its ETag, the sha256 followed by a short hash of the content type, so
that identical bytes stored under two content types stay distinct; `getByETag` returns the content
type of the entry that `exists` found and a placeholder stream, which `serveAsset` replaces with the
body. Nothing is added to Cloudflare's headers. Long caching of hashed files is a `_headers` rule,
as on Cloudflare.

When `route` finds the version in state `ready`, it says so, and `serveAsset` calls `markLive`
once; concurrent first requests all call it, and it is idempotent. When the version does not exist
or is still `uploading`, `serveAsset` returns null.

Other HTTP routes of the app (auth, APIs) win over the site route when they are exact paths or
longer prefixes, by Convex's router rules for the same method.

## Component

Two tables.

| Table      | Fields                                                                                         | Indexes                                        |
| ---------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `versions` | `versionId`, `state` (`uploading`, `ready`, `live`), `config` (JSON string)                    | `by_versionId`                                 |
| `entries`  | `versionId`, `path`, `sha256` (hex), `size`, `contentType`, `storageId` (absent until recorded) | `by_version_path`, `by_sha256`, `by_storageId`, and one that finds a version's entries without a file |

Creation times come from `_creationTime`. `config` is the JSON of Cloudflare's `AssetConfig` for the
version: `html_handling`, `not_found_handling`, `headers`, `redirects`. It is a string because
`redirects.staticRules` has one field per rule and Convex limits an object to 1,024 fields. A
document is limited to 1 MiB, so the CLI refuses a config above 900 KiB and names the file that
causes it; Cloudflare's own rule limits (100 header rules, 2,000 static and 100 dynamic redirects)
fit unless paths are very long.

Functions. The CLI calls the internal ones with `npx convex run --component`; `serveAsset` calls the
two public ones through the component reference.

| Function             | Kind              | Does                                                                                                       |
| -------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `generateUploadUrls` | internal mutation | Returns `count` upload URLs.                                                                               |
| `startVersion`       | internal action   | Reads the manifest from storage and, through internal mutations in batches, creates the version and its entries, reusing recorded files by sha256. Idempotent for the same id and manifest. |
| `missingEntries`     | internal query    | Returns one page of the version's entries without a file.                                                  |
| `recordFiles`        | internal mutation | Attaches stored files to entries after checking sha256 and size.                                           |
| `finishVersion`      | internal mutation | Marks the version `ready` when no entry is without a file; otherwise reports how many are.                 |
| `route`              | public query      | Runs Cloudflare's `canFetch` and `handleRequest` for one request against one version.                      |
| `markLive`           | public mutation   | Marks a `ready` version `live` and schedules the deletion pass.                                            |
| `deleteOlder`        | internal mutation | Deletes versions created before the live one, their entries, and the stored files no remaining entry uses; then sweeps `_storage` for unreferenced files; in batches, scheduling itself until done. |

The package sets no limits of its own. Convex's limits apply: 1 MiB per document, and the
transaction limits (16,000 writes, 32,000 documents scanned, 16 MiB read, 8,192 array elements,
4,096 index ranges) shape the batches.

## Not here, and why

- No live pointer, no `activate`, no `getLiveVersion`: the pushed code names its version.
- No cleanup command, no cron, no retention: the first request of a new version deletes the older
  ones.
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
  - `src/component`: `schema.ts`, `lib.ts`, `convex.config.ts`, and its generated files.
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
