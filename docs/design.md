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
first request that new code serves finds its version in state `ready` and marks it `live`. Marking a
version live deletes the versions that were live before it, because their code is gone by
definition. A version that never becomes live, from a push that failed, is garbage, not a
correctness problem; it is deleted when it is a day old, at a later switch. That day is the only
time constant in the design and it bounds garbage only. Two deploys that overlap both complete, the
last push wins, and no overlap can break the site: a version is deleted only after another version
has served in its place.

## Deploy

```
convex-hosting deploy --build "<command>" --dist <dir> [--dev | --preview <name>] [--html-handling ...] [--not-found-handling ...] [--component <name>]
```

One command for every target. Without a flag, production: `npx convex deploy` pushes there by
default, and every `npx convex run` of the deploy gets `--prod`, because `run` goes to development
by default. `--preview <name>`: both commands get `--preview-name <name>`. `--dev`: the development
deployment this checkout is bound to, the one `npx convex dev` and `npx convex run` pick from
`.env.local`; no selector is passed, and the push is `npx convex run --push` (which pushes the whole
`convex/` like `npx convex dev --once` does, typecheck included, and works whether or not
`npx convex dev` is running). A deploy key in the environment (`CONVEX_DEPLOY_KEY` or its alias
`CONVEX_DEPLOYMENT_TOKEN`) wins over the selector in both commands, the same way. A self-hosted
deployment (`CONVEX_SELF_HOSTED_URL`) takes no selector. The CLI parses no credential.

1. The CLI chooses a random version id.
2. Production and preview: it runs
   `npx convex deploy --cmd "<command> && convex-hosting upload --dist <dir> --version-id <id> ..."`.
   Both run in the project directory; a build must not change directory. Convex gives the build the
   deployment's URL in `CONVEX_URL` and in one framework variable such as `VITE_CONVEX_URL`, as it
   documents for frontends. Inside the command, `upload`:
   1. collects the files of `<dir>`, honoring `.assetsignore` and following symbolic links as
      Wrangler does (a link to nothing, or back into a folder already walked, is skipped with a
      message), and computes each file's sha256 and content type; refuses a file above 25 MiB,
      Cloudflare's limit per asset (the HTTP action that serves a file could not answer more than
      Convex's 100 MiB response limit anyway); reads `_headers` and `_redirects` with Cloudflare's
      parsers into the version's config;
   2. stores the config as one file through an upload URL, because `npx convex run` passes arguments
      on the command line, which the operating system limits, and a `_redirects` file can be large;
      (`npx convex run` stays the transport because it handles every way a deployment is selected:
      login, deploy keys, previews by name;) then calls `createVersion` with the config's storage
      id, which creates the version in state `uploading`;
   3. asks `knownFiles` which of its hashes already have a stored file, from any version's entries,
      in batches that fit a command line;
   4. uploads the other files a few at a time, then sends every entry complete, with its storage id
      (the known ones from step 3, the new ones from the upload), in batches to `recordFiles`, which
      checks each stored file's sha256 against Convex's storage metadata and inserts the entries; an
      entry is never without a file;
   5. calls `finishVersion`, which puts the version in state `ready`. The CLI calls it only after
      every batch succeeded; a crashed upload leaves an `uploading` version, and a retry reuses
      every file the crashed run stored, through step 3;
   6. writes `.convex-hosting/version.js` with the id, in the CLI's state folder at the project
      root, like Wrangler's `.wrangler/`; the folder carries its own `.gitignore`, so nothing of it
      reaches git and no tool writes into `convex/`. The file is a build artifact that `http.ts`
      imports, as a server-rendered app's `http.ts` already imports its server build; the package
      ships the declaration of that module (an ambient wildcard module in a script `.d.ts` that the
      package's types entry references), so a fresh clone typechecks with nothing added. Then, still
      inside `npx convex deploy`, Convex bundles `convex/` with the new id and pushes. The push is
      the switch, and the command ends.
3. `--dev`: the same steps, in one process: the CLI runs the build itself (Vite reads the
   deployment's URL from `.env.local`, so no nesting is needed), uploads, writes the version file,
   and pushes with `npx convex run --push`.

**First install.** The component's functions exist only after a push, and a new preview deployment
exists only once `npx convex deploy` has created it, which happens before it runs the command. So
the upload decides. Its first call is a probe, `npx convex run --component <name> --inline-query`,
because that path of the Convex CLI looks the component up before it runs anything and prints the
exact message `Component path "<name>" was not found.` when the deployment does not have it (a
function run against a missing component answers only a generic server error, which must not count).
On that exact message, the production and preview upload writes the version file and a marker file
in `.convex-hosting/` and exits without uploading, so the push that follows installs the component;
`deploy` sees the marker after `npx convex deploy` returns and runs the upload then. For `--dev`, in
one process, it writes the version file, pushes, and uploads. Until that upload ends, the site
answers 404 (see Serve). Once per deployment.

**The development loop.** Local work uses Vite's dev server, with hot reload, against the
development deployment's URL, while `npx convex dev` pushes function changes, as in any Convex app.
`convex-hosting deploy --dev` is a one-shot command for when the development deployment itself
should serve the current build. There is no watch mode: a build, an upload, and a push per change is
not an inner loop, and Cloudflare's tooling has the same shape. A fresh clone runs `deploy --dev`
once; after that the version file exists and `npx convex dev` bundles as usual. Two things in this
loop are transient and documented, not solved: when a server-rendered app's build changes
`dist/server`, which `http.ts` imports, a running `npx convex dev` pushes before `deploy --dev` has
written the new id, so pages reference files that answer 404 until that run ends; and a production
deploy run from the same checkout writes production's id, which a running `npx convex dev` then
pushes to the development deployment, where that version does not exist, until the next
`deploy --dev`. Production deploys belong in CI or a separate checkout.

**Failures.** A deploy that dies before the push leaves a version that nothing serves; a later
switch deletes it when it is a day old. An upload that dies leaves a version in state `uploading`,
deleted the same way, and a retry reuses the files it stored. Stored files are deleted by one rule:
no entry references them, they are a day old, and they were already unreferenced when the deletion
chain started, because the sweep runs before the version deletion in each chain. That covers a
deleted version's unshared files, a file stored but never recorded, and the config files. An upload
in progress that took a stored file from `knownFiles` loses it only if two switches happen during
that one upload; it then fails with a message that says so, and a retry works. A push that the
command reports as failed may still have landed; the site then serves the new version, which marks
itself live at its first request, and the next deploy is a normal one. No resume logic. Two first
deploys at once behave like any other overlap: both push and upload, the last push wins, and the
other version is garbage after a day.

**Browsers.** A page opened before a deploy keeps asking for its hashed files, which now answer 404,
exactly as on Cloudflare. An app that wants to reload on a new version adds one query that returns
the bundled `versionId` and reloads when its value changes. The README shows it. The component has
no part in it.

## Serve

The app's `convex/http.ts` has one route, `GET` with `pathPrefix: "/"`. Convex answers `HEAD`
through the `GET` handler and drops the body. Other methods are the app's own routes, as on
Cloudflare a `POST` goes to the Worker.

```ts
import { serveAsset } from "@samebase/convex-hosting";
import { versionId } from "../.convex-hosting/version.js";

const asset = await serveAsset(ctx, components.hosting, request, versionId);
if (asset) return asset;
// A static site: 404 with `Cache-Control: no-store`. A server-rendered site: render the page,
// also with `no-store`, because the deployment's Cloudflare front caches answers on static-looking
// paths.
```

`serveAsset` calls the component query `route` with the method, the URL, and the four request
headers that Cloudflare's handler reads (`If-None-Match`, `Sec-Fetch-Mode`, and the presence of
`Authorization` and `Range`). Inside the query, Cloudflare's `canFetch` decides whether an asset
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
that body and returns the response. When the query finds no storage URL for the entry, or storage
answers 404, because a deletion pass removed the file, the answer is 404 with
`Cache-Control: no-store`; any other fetch failure answers 502 with no caching. An app cannot read a
component's storage, so each asset hit costs that one fetch.

When the version does not exist, is still `uploading`, or is `deleting`, `serveAsset` returns a 404
response that names the version, with `Cache-Control: no-store`, so a half-installed site answers
404 rather than rendering pages without their files, and the deployment's Cloudflare front, which
caches 404 answers on static paths, does not keep that answer after the upload ends. `null` means
one thing: no asset matched, and the app continues.

When `route` reports the version in state `ready`, `serveAsset` calls `markLive` once, before it
answers. The mark is a compare-and-set: `route` also returns the time of the newest live version it
observed in the same query, `markLive` compares it with the newest live version inside its own
transaction, and marks only when they agree. So a request whose code was replaced between its lookup
and its mark cannot make its version newest, concurrent first requests mark once, and a late push
whose code really is deployed marks normally. That is the only write the serving path ever makes,
once per deploy.

The two callbacks that Cloudflare's code takes map to the version's entries: `exists(path)` reads
one index entry and returns its ETag, the sha256 followed by a short hash of the content type, so
that identical bytes stored under two content types stay distinct; `getByETag` returns the content
type of the entry that `exists` found and a placeholder stream, which `serveAsset` replaces with the
body. Nothing is added to Cloudflare's headers. Long caching of hashed files is a `_headers` rule,
as on Cloudflare.

Other HTTP routes of the app (auth, APIs) win over the site route when they are exact paths or
longer prefixes, by Convex's router rules for the same method.

## Component

Two tables.

| Table      | Fields                                                                                                                  | Indexes                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `versions` | `versionId`, `state` (`uploading`, `ready`, `live` with the time it became live, or `deleting`), `config` (JSON string) | `by_versionId`                                 |
| `entries`  | `versionId`, `path`, `sha256` (hex), `contentType` (absent when the file name has no known type), `storageId`           | `by_version_path`, `by_sha256`, `by_storageId` |

The time a version became live lives inside the `live` state, so a version cannot carry a live time
without being live; a mark sets it strictly later than the newest live time, so two marks in one
millisecond still order. `deleting` is set before a version's entries go, so a version half deleted
cannot become live. Creation times come from `_creationTime`. `config` is the JSON of Cloudflare's
`AssetConfig` for the version: `html_handling`, `not_found_handling`, `headers`, `redirects`. It is
a string because `redirects.staticRules` has one field per rule and Convex limits an object to 1,024
fields. A document is limited to 1 MiB, so the CLI refuses a config above 900 KiB, leaving room for
the other fields and the encoding, and names the file that causes it. An entry keeps its own content
type because the type belongs to the path, not to the bytes: paths with identical bytes share one
stored file but keep their own types, and `route` serves without reading `_storage`.

Functions. The CLI calls the internal ones with `npx convex run --component`, by typed function
reference; `serveAsset` calls the two public ones through the component reference (an app can call
only a component's public functions, and clients cannot call them at all).

| Function             | Kind              | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateUploadUrls` | internal mutation | Returns `count` upload URLs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `createVersion`      | internal action   | Reads the config from storage and creates the version in state `uploading`. Idempotent for the same id and config.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `knownFiles`         | internal query    | For a list of hashes, the stored file ids that entries of any version already have.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `recordFiles`        | internal mutation | Inserts complete entries after checking each stored file's sha256; an entry that exists with the same hash is skipped.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `finishVersion`      | internal mutation | Marks the version `ready`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `route`              | public query      | Runs Cloudflare's `canFetch` and `handleRequest` for one request against one version; reports the version's state.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `markLive`           | public mutation   | Marks a `ready` version `live`, strictly later than the newest live time, and schedules `collect`, only when the newest live version is still the one the request's lookup observed; otherwise, and for a version already live, a no-op; a version in `deleting` is refused.                                                                                                                                                                                                                                                           |
| `collect`            | internal mutation | Deletes the versions that were live before the current live one and the versions that are not live and a day old, with their entries; then the `_storage` files that no entry references and are a day old. The sweep runs before the version deletion in each chain, so a file freed by a switch is deleted at a later switch; an upload that took a file from `knownFiles` fails only if two switches happen during that one upload, and a retry works; one batch per call, scheduling itself with `runAfter(0)` while work remains. |

The package sets one limit of its own, 25 MiB per file, for the reason above. Convex's limits apply:
1 MiB per document, and the transaction limits (16,000 writes, 32,000 documents scanned, 16 MiB read
and written, 8,192 array elements, 4,096 index ranges, argument and result sizes) shape the batches.

## Stated, not solved

- A request already running on old code when a push lands, whose first lookup happens after the new
  code's first request marked its version, passes the compare-and-set and supersedes the new
  version. The window is the microseconds between an action's start and its first query, and it
  needs a push and a first request to complete inside it. Stated, not mechanized.
- An upload that took a stored file from `knownFiles` loses it only if two switches happen during
  that one upload; it fails with a message that says so, and a retry works.
- The site route is `GET`; a `POST` or `OPTIONS` to an asset path reaches the app, where
  Cloudflare's assets-only mode would answer 405. The app is the Worker.
- No `run_worker_first`, no `base_path`, no selectable compatibility date: an app that needs its
  route to win over an asset registers an exact route or a longer prefix.
- No upload retry: a transient storage failure fails the deploy, and the next deploy reuses every
  file the failed one recorded.

## Not here, and why

- No live pointer that a command moves, no `activate`, no `getLiveVersion`: the pushed code names
  its version, and the serving code reports it.
- No lock, no heartbeat, no cron, no call after the push: a version is deleted only after another
  version has served in its place. A one-day age bounds garbage from failed deploys; it decides
  nothing about what is served.
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
  - `src/client`: `serveAsset`, and the shipped declaration of the version module.
  - `src/cli`: the `convex-hosting` command: `deploy`, and `upload`, the inner step that
    `npx convex deploy --cmd` has to call as a program.
  - `src/workers-shared`: Cloudflare's asset worker and its tests, copied by
    `scripts/sync-workers-shared.ts` from cloudflare/workers-sdk at the commit in `UPSTREAM`. Only
    the sync script changes it.
  - Whatever `npx convex codegen --component-dir ./src/component` needs to run against an anonymous
    local deployment, and nothing more; `CONTRIBUTING.md` says what that is. No example is involved.
- `packages/convex-hosting-tanstack-start`: the Vite settings and the server entry that make
  TanStack Start's server build run inside a Convex HTTP action (Convex cannot bundle `node:stream`,
  so pages render with React's Web Stream renderer). It knows nothing about versions.
- `examples/spa`: a Vite app served with `--not-found-handling single-page-application`.
- `examples/tanstack-ssr`: pages rendered in the app's HTTP action after `serveAsset`.
- One `README.md` at the repository root, copied into the package at `prepack`.
- An app has `.convex-hosting/` (ignored, written by the CLI) and nothing else of ours outside
  `convex/convex.config.ts` and `convex/http.ts`.
