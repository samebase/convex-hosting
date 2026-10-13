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

## Deploy

```
convex-hosting deploy --build "<command>" --dist <dir> [--html-handling ...] [--not-found-handling ...]
```

1. The CLI chooses a random version id.
2. It runs `npx convex deploy --cmd "<command> && convex-hosting upload --dist <dir> --version-id <id> ..."`.
   Convex gives the build the deployment's URL variables, as it documents for frontends. Inside the
   command, `upload`:
   1. collects the files of `<dir>`, honoring `.assetsignore`, and computes each file's sha256,
      size, and content type; reads `_headers` and `_redirects` with Cloudflare's parsers;
   2. stores the manifest (the config and the entries) as one file and calls `startVersion`, which
      creates the version in state `uploading` with its entries, gives each entry whose sha256 a
      stored file already has that file, and returns the entries still needed, each with an upload
      URL;
   3. uploads those files, a few at a time, and calls `recordFiles` in batches; the component
      checks each file's sha256 and size against Convex's storage metadata;
   4. calls `finishVersion`, which puts the version in state `ready` when every entry has a file;
   5. writes `convex/hostingVersion.ts` with the id.
   Then, still inside `npx convex deploy`, Convex bundles `convex/` with the new id and pushes. The
   push is the switch.
3. The CLI calls `cleanup` with the new id. The component deletes every other version, its entries,
   and the stored files that no remaining entry uses, in batches that stay inside Convex's
   transaction limits.

**First install.** The component's functions exist only after a push. `deploy` calls one component
function first; when the call fails, it writes the version file, pushes, and then uploads. The site
answers 404 until that upload ends. This happens once per deployment.

**Development deployment.** `npx convex deploy` targets production or a preview. For the
development deployment the developer runs `npx convex dev`, which pushes on every change in
`convex/`, and uploads with the build of their choice:

```
vite build && convex-hosting upload --dist dist
```

`upload` writes the version file last, and the running `npx convex dev` pushes it. Because that push
is asynchronous, `upload`'s cleanup keeps two versions: the new one and the one the version file
named before, which the running code still references. (`deploy` cleans after its own push, so it
keeps only the new one.)

**Fresh clone.** `convex/hostingVersion.ts` is ignored by git. `npx convex dev` cannot bundle
`convex/http.ts` until the file exists, and `upload` cannot store files until the component is
pushed. `upload` resolves this on its first run: when the component does not answer, it writes the
version file and stops with the message that `npx convex dev` now pushes the component and that
`upload` must run again.

**Failures.** A deploy that dies after the push leaves old versions until the next deploy. An upload
that dies leaves a version in state `uploading`; the next upload reuses every file it stored, and
the next cleanup deletes it. No resume logic.

**Browsers.** A page opened before a deploy keeps asking for its hashed files, which now answer
404, exactly as on Cloudflare. An app that wants to reload on a new version adds one query that
returns the bundled `versionId` and reloads when its value changes. The README shows it. The
component has no part in it.

## Serve

The app's `convex/http.ts` has one route for `GET` and one for `HEAD` with `pathPrefix: "/"`:

```ts
import { serveAsset } from "@samebase/convex-hosting";
import { versionId } from "./hostingVersion.js";

const asset = await serveAsset(ctx, components.hosting, request, versionId);
if (asset) return asset;
// A static site: 404. A server-rendered site: render the page.
```

`serveAsset` calls one component query, `route`, with the method, the URL, and the request headers
that Cloudflare's handler reads. Inside the query, Cloudflare's `canFetch` decides whether an asset
answers. The app is the Worker, so Cloudflare's routing with a Worker applies: a request that does
not resolve to a file goes to the app, and `not_found_handling` (the 404 page, the single-page
fallback) applies to navigation requests only. When an asset answers, Cloudflare's `handleRequest`
computes the status and headers: `Cache-Control: public, max-age=0, must-revalidate`, `ETag`, 304
for `If-None-Match`, `_headers` rules, `_redirects`, `html_handling`. The query returns the status,
the headers, and the storage URL of the body, if there is one. `serveAsset` fetches the body from
that URL and returns the response. (An app cannot read a component's storage, so each asset hit
costs that one fetch.)

The two callbacks that Cloudflare's code takes map to one index read each: `exists(path)` returns
the entry's sha256 as the ETag; `getByETag` returns the entry's content type and a stream that
`serveAsset` replaces with the body. Nothing is added to Cloudflare's headers. Long caching of hashed
files is a `_headers` rule, as on Cloudflare.

Other HTTP routes of the app (auth, APIs) win over the site route when they are exact paths or
longer prefixes, by Convex's router rules.

## Component

Two tables.

| Table      | Fields                                                                         | Indexes                                        |
| ---------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `versions` | `versionId`, `state` (`uploading` or `ready`), `createdAt`, `config` (JSON)    | `by_versionId`                                 |
| `entries`  | `versionId`, `path`, `sha256` (hex), `size`, `contentType`, `storageId` (optional until recorded) | `by_version_path`, `by_sha256`, `by_storageId` |

`config` is the JSON of Cloudflare's `AssetConfig` for the version: `html_handling`,
`not_found_handling`, `headers`, `redirects`, `compatibility_date`. It is a string because Convex
limits an object to 1,024 fields and a `_headers` file can hold more rules than that.

Five functions, all internal. The CLI calls them with `npx convex run --component`; `serveAsset`
calls `route` through the component reference.

| Function        | Kind     | Does                                                                                   |
| --------------- | -------- | -------------------------------------------------------------------------------------- |
| `startVersion`  | action   | Reads the manifest from storage, creates the version and its entries, returns the missing entries with upload URLs. Idempotent for the same id and manifest. |
| `recordFiles`   | mutation | Attaches stored files to entries after checking sha256 and size.                      |
| `finishVersion` | mutation | Marks the version `ready`, or returns the entries still without a file.               |
| `route`         | query    | Runs Cloudflare's `canFetch` and `handleRequest` for one request against one version. |
| `cleanup`       | mutation | Deletes every version not in `keep`, with its entries and unshared files, in batches, scheduling itself until done. |

Limits are Cloudflare's: 20,000 files per version, 25 MiB per file. Convex's transaction limits
(16,000 writes, 8,192 array elements, 16 MiB read) shape the batches, not the limits.

## Not here, and why

- No live pointer, no `activate`, no `getLiveVersion`: the pushed code names its version.
- No cron, no retention: `deploy` and `upload` delete what nothing references.
- No marking of hashed files, no one-year `Cache-Control`: Cloudflare has neither. A site that wants
  them writes one `_headers` rule.
- No component HTTP route, no `httpPrefix` mount, no second serving helper: one way for static and
  server-rendered sites. A component route could not hand a request to the app's renderer.
- No post-deploy verification, no version meta tag: `wrangler deploy` has none. The push succeeds or
  fails.
- No base path: the site is served at the origin root.
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
  - `convex.json` and an empty `convex/`: what `npx convex codegen --component-dir` needs, with an
    anonymous local deployment. No example is involved.
- `packages/convex-hosting-tanstack-start`: the Vite settings and the server entry that make
  TanStack Start's server build run inside a Convex HTTP action (Convex cannot bundle
  `node:stream`, so pages render with React's Web Stream renderer). It knows nothing about versions.
- `examples/spa`: a Vite app served with `--not-found-handling single-page-application`.
- `examples/tanstack-ssr`: pages rendered in the app's HTTP action after `serveAsset`.
- One `README.md` at the repository root, copied into the package at `prepack`.
