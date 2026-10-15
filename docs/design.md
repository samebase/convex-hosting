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
definition. Nothing is deleted by the clock alone: deletion runs only at a switch, when a new
version becomes live, so a deployment that gets no request deletes nothing and keeps its version
intact for its first request, whenever it comes. At a switch, a version that never became live is
dead too, from a push that failed, with one exception: a slower deploy whose push has not landed
yet. So a never-live version is deleted at a switch only when it is more than a day old; the day
bounds how late a push may follow its upload, and it is the only time constant in the design. Two
deploys that overlap both complete, the last push wins, and no overlap can break the site: a version
is deleted only after another version has served in its place.

## Deploy

```
convex-hosting deploy --build "<command>" --dist <dir> [--dev | --preview-name <name>] [--html-handling ...] [--not-found-handling ...] [--component <name>]
```

One command for every target. Without a flag, production: `npx convex deploy` pushes there by
default, and every `npx convex run` of the deploy gets `--prod`, because `run` goes to development
by default. `--preview-name <name>`, the Convex CLI's own flag name, is passed to both commands as
is. `--dev`: the development deployment this checkout is bound to, the one `npx convex dev` and
`npx convex run` pick from `.env.local`; no selector is passed, and the push is
`npx convex run --push` (which pushes the whole `convex/` like `npx convex dev --once` does,
typecheck included, and works whether or not `npx convex dev` is running). A deploy key in the
environment (`CONVEX_DEPLOY_KEY` or its alias `CONVEX_DEPLOYMENT_TOKEN`) wins over the selector in
both commands, the same way. A self-hosted deployment (`CONVEX_SELF_HOSTED_URL`) takes no selector.
The CLI parses no credential.

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
not an inner loop, and Cloudflare's tooling has the same shape. A fresh clone has no version file,
so `npx convex dev` cannot bundle `http.ts`, and with an anonymous local deployment `deploy --dev`
cannot help, because it needs a running `npx convex dev`. So `convex-hosting init` writes the
version file with the placeholder id `not-deployed`, which no deploy creates (deploys use random
UUIDs), and keeps an existing file. A server-rendered app's `http.ts` also imports
`.convex-hosting/server.js`, which the framework adapter's Vite plugin writes after each server
build as a re-export of the build's entry (a copy would break the entry's relative chunk imports),
in the working directory like the CLI, which runs the build in the project directory; `init` writes
a placeholder there whose `fetch` answers 503 `no-store`, and keeps an existing file. `serveSite`
reaches it only for a version that exists, so a fresh clone's site answers the same 404. Apps run
`init` before `npx convex dev`, for example as a `predev` script. Until the first deploy, the site
answers 404 naming the placeholder id. A plain `npx convex deploy` after `init` pushes the
placeholder id and the site answers 404, which is why production and previews deploy only through
`convex-hosting deploy`. Two things in this loop are transient and documented, not solved: when a
server-rendered app's build changes `dist/server`, which `http.ts` imports through
`.convex-hosting/server.js`, a running `npx convex dev` pushes before `deploy --dev` has written the
new id, so pages reference files that answer 404 until that run ends; and a production deploy run
from the same checkout writes production's id, which a running `npx convex dev` then pushes to the
development deployment, where that version does not exist, until the next `deploy --dev`. Production
deploys belong in CI or a separate checkout.

The fixed path is also what keeps `convex/http.ts` the same for every framework: the route imports
`../.convex-hosting/server.js` whatever the framework, and the adapter's build step points that file
at the framework's own output, a `server.js` or `server.mjs` under `dist/server` for TanStack Start,
a prebundled module for another framework. The hosting package's declaration of that module, a
default export with `fetch(request, ...)`, is the contract an adapter meets.

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
import { serveSite } from "@samebase/convex-hosting";
import { versionId } from "../.convex-hosting/version.js";

return serveSite(ctx, components.hosting, request, versionId, render);
```

`serveSite` answers with the file when one matches. Otherwise it answers with the page that the
optional `render()` returns, else 404, both with `Cache-Control: no-store`; the page keeps every
other header, several `Set-Cookie` included. Measured on 2026-10-14: the deployment's Cloudflare
front keeps `no-store` for a path without an extension and answers `public, max-age=14400` with
`cf-cache-status: BYPASS` for a path with one, so the browser, not the edge, caches a 404 for a
missing script for four hours. The deploy order prevents that case: a version's files exist before
any page refers to them, and a first install serves no page until its upload ends. `serveAsset` is
its first step, exported for a route that does something else on a miss: it returns `null` when no
file matches.

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

## Orderings and timing

Every interleaving worked through for 0.4, what happens, and what checks it. "Component test" is a
convex-test run of the exact order of transactions; "runtime" is a run against a local backend.

| What happens                                                                                             | Outcome                                                                                                                                        | Checked by                               |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A deploy pushes; the first request arrives                                                               | The version is marked live; the versions live before it are deleted                                                                            | Component test, runtime                  |
| Two deploys overlap; the pushes land in creation order                                                   | Both complete; the last push's version is marked live at its first request; the other was never live and goes at a later switch when a day old | Component test (age rule)                |
| Two deploys overlap; the earlier-created one pushes last                                                 | Its first request reads the other as newest, the compare-and-set passes, it is marked live, the other is deleted                               | Component test (late push)               |
| A request on old code is in flight when a push lands, and its mark comes after the new code's first mark | The compare-and-set refuses the stale mark                                                                                                     | Component test (stale mark)              |
| The same, but its lookup also runs after the new code's first mark                                       | The stale mark passes; the window is the microseconds between an action's start and its first query                                            | Stated                                   |
| Two first requests of one version                                                                        | One mark; the second is a no-op                                                                                                                | Component test                           |
| Two marks in one millisecond                                                                             | The second is strictly later                                                                                                                   | Component test                           |
| A deploy dies before its push                                                                            | A never-live version; deleted at a later switch when a day old                                                                                 | Component test (age rule)                |
| An upload dies midway                                                                                    | An `uploading` version; same fate; a retry reuses its recorded files                                                                           | Component test, runtime (reuse)          |
| The push is reported as failed but landed                                                                | The version is `ready` and is marked live at its first request                                                                                 | Inherent; stated                         |
| No request for days, weeks                                                                               | Nothing is deleted; the first request marks the version live                                                                                   | Inherent: deletion runs only at a switch |
| Many deploys, no requests in between                                                                     | The first request marks the newest; older never-live versions go when a day old, younger ones at the next switch                               | Component test (age rule)                |
| A push lands more than a day after its upload, after another switch                                      | Its version is gone; the site answers 404 naming it; redeploy                                                                                  | Stated                                   |
| An upload borrows a stored file; a switch deletes the lending version                                    | The file survives: files go only when unreferenced, a day old, and already unreferenced when the chain started                                 | Component test (sweep order)             |
| Two switches during one upload                                                                           | The borrowed file can go; `recordFiles` says so; a retry works                                                                                 | Stated                                   |
| A first request reaches a version while its entries are being deleted in pages                           | The version is `deleting`: 404, no mark                                                                                                        | Component test                           |
| Documents share a creation time at a page boundary                                                       | The cursor carries the ids seen at that time; none is skipped                                                                                  | Component test (crafted cursor)          |
| First install: the component does not exist yet                                                          | Push first, then upload; 404 until the upload ends                                                                                             | Runtime (both flows)                     |
| Two first installs at once                                                                               | Both push and upload; the last push wins                                                                                                       | Stated                                   |
| Two commands from one checkout at once                                                                   | They overwrite each other's build output and version file                                                                                      | Stated, unsupported                      |
| A production deploy from a checkout where `npx convex dev` runs                                          | Production's id is pushed to development until the next `deploy --dev`                                                                         | Stated                                   |
| `deploy --dev` against an anonymous local deployment without `npx convex dev`                            | Each Convex CLI call starts and stops its own backend; the upload fails                                                                        | Stated in the README                     |

Not reproducible in the test runtime and not yet run against a cloud deployment: two real pushes in
a chosen order, a preview deployment, an old HTTP action kept running across a push. A smoke script
against a disposable preview deployment, run by hand with a deploy key before a release, is the
place for those.

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

## Rejected on the way

Approaches that were built or proposed during the 0.4 design and dropped, with the reason, so they
are not proposed again.

- **Deletion driven by the CLI after the push.** The order in which overlapping deploys report back
  is not the order in which their pushes landed, so a CLI could delete the version that is live.
- **A deploy lock in the component, with a heartbeat and a two-minute expiry, and a kill of the push
  when a heartbeat reports the lock lost.** It grew to five mechanisms to buy one refusal message.
  The push is not a call to the component, so a frozen process could still push after losing the
  lock; a heartbeat before the lock existed, or after another deploy deleted the version row, had no
  ground truth; killing `npx convex deploy` left its inner build running.
- **An hourly pass with a grace period, and a ten-minute age rule.** A time constant decided what is
  served, and creation order is not push order: a slower deploy created earlier and pushed later
  would lose its version.
- **Deleting by creation order when a version is marked live.** The same slower-deploy problem;
  deletion now follows "was live before the current one", which creation order cannot express.
- **A committed version file in `convex/`.** Its value is set by the deploy that pushes it, so the
  committed value is never used by a correct deploy; it left stale ids and merge conflicts in git,
  and a plain `npx convex deploy` from a clean checkout would push a stale id and take the site
  down.
- **An ignored version file with a declaration file in every app.** The declaration is shipped by
  the package instead, so the app adds nothing.
- **A standalone `upload` for the development deployment, relying on the `npx convex dev` watcher to
  push.** The watcher does not look again at a module that failed to resolve, the development site
  answered 404 between the upload and the push, and the same command with a production key would
  have deleted production's live version. `deploy --dev` runs the whole flow itself.
- **Marking hashed files, a one-year cache header, and a cross-version fallback for hashed paths.**
  Cloudflare has none of them; a site writes one `_headers` rule. The fallback existed only to paper
  over a window between the push and a pointer flip, which the design no longer has.
- **A component HTTP mount and a second serving helper.** Two ways to serve, and a component route
  cannot hand a request to the app's renderer, so server-rendered sites could not use the mount.
- **Post-deploy verification through a version meta tag.** Wrangler has none; the push succeeds or
  fails, and the tag forced a Vite plugin and a server wrapper that existed only for it.
- **A push-time lock check through Convex's schema validation (a literal id in the schema).** The
  live schema controls every write, so the next deploy could never write its own id into the row.
- **A subshell so that a build command may change directory.** Shell-specific; the build runs in the
  project directory instead.
- **A `size` field on entries.** A matching sha256 already proves the bytes are the same.
- **An app-side script that builds the app once before `npx convex dev`** (Bristol's
  `scripts/ensure-server-build.ts`), because `convex/http.ts` imported `dist/server/server.js`.
  Every server-rendered app would copy it, and a full build blocked the first push. The import now
  names `.convex-hosting/server.js`, which `init` writes as a placeholder and the adapter's plugin
  points at each build.
- **Wrapping the Convex Auth session lines in this package.** The hosting package must not depend on
  Convex Auth, and the lines are Convex Auth's own API; a helper for HTTP actions belongs upstream.

## What an app writes

One row per piece of a TanStack Start app with Convex Auth cookie sessions on this host, with its
owner since `@samebase/convex-hosting` 0.6.0 and `@samebase/convex-hosting-tanstack-start` 0.3.0.

| Piece                                                     | Owner                                                                                                                        | Why                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| File serving, and `no-store` on rendered pages and misses | Hosting package: `serveSite`                                                                                                 | The Cloudflare front caches answers on static-looking paths of every site                   |
| The server entry import and `fetch(request, { context })` | App: `import server from "../.convex-hosting/server.js"`, called in `serveSite`'s `render`                                   | Convex bundles what `http.ts` imports, and a fixed path resolves before any build           |
| `.convex-hosting/server.js`                               | Adapter: `convexSsr()` re-exports the build's entry after each server build; hosting package: `init` writes a placeholder    | A fresh clone pushes before its first build                                                 |
| The type of `.convex-hosting/server.js`                   | Hosting package: an ambient declaration next to the version module's; the app leaves `allowJs` out of `convex/tsconfig.json` | A file that a tool writes has no declaration, and with `allowJs` tsc reads the file instead |
| `src/server.ts`                                           | App: one line that re-exports the adapter's `server`                                                                         | Start builds its server entry from a file in the app's `src/`                               |
| `convexSsr()`                                             | Adapter, added to the app's `vite.config.ts`                                                                                 | The Vite config is the app's; the settings are the adapter's                                |
| The `requestContext` type                                 | Adapter `convex-auth`, on the `Register` of `@tanstack/react-start`                                                          | The token is the Convex Auth session's, and Start reads that `Register`                     |
| `expectAuth`                                              | App, in `getRouter`                                                                                                          | The app creates the Convex client                                                           |
| The root `beforeLoad`                                     | Adapter `convex-auth`: `sessionBeforeLoad`                                                                                   | The same lines in every app with this session                                               |
| The provider, plus the release of `expectAuth`            | Adapter `convex-auth`: `SessionProvider`                                                                                     | Convex's provider never releases `expectAuth` for a signed-out visitor                      |
| The gate                                                  | Adapter `convex-auth`: `redirectWithoutSession` and `RedirectWithoutSession`; the app gives the redirect options             | Only the server render has the cookie; the browser follows the provider                     |
| The session state in components                           | Adapter `convex-auth`: `useSignedIn`, `SignedIn`, and `SignedOut`                                                            | Convex's provider reports loading during the server render and the hydration                |
| The cookie session lines in `http.ts`                     | Convex Auth's own API, written in the app                                                                                    | A helper for HTTP actions belongs upstream                                                  |
| The `/auth/*` routes                                      | Convex Auth's own API (`setupConvexAuthServer`), registered by the app                                                       | The handlers are Convex Auth's; the paths are the app's                                     |
| The Convex Auth setup files                               | App, with Convex Auth's own API                                                                                              | The providers and the users table are the app's                                             |
| Deploy and preview commands                               | Hosting package: `convex-hosting deploy`, in the app's scripts and CI                                                        | The upload must run between the build and the push                                          |

## Repository

- `packages/convex-hosting`
  - `src/component`: `schema.ts`, `lib.ts`, `convex.config.ts`, and its generated files.
  - `src/client`: `serveSite`, `serveAsset`, and the shipped declarations of the version and server
    modules.
  - `src/cli`: the `convex-hosting` command: `init`, `deploy`, and `upload`, the inner step that
    `npx convex deploy --cmd` has to call as a program.
  - `src/workers-shared`: Cloudflare's asset worker and its tests, copied by
    `scripts/sync-workers-shared.ts` from cloudflare/workers-sdk at the commit in `UPSTREAM`. Only
    the sync script changes it.
  - Whatever `npx convex codegen --component-dir ./src/component` needs to run against an anonymous
    local deployment, and nothing more; `CONTRIBUTING.md` says what that is. No example is involved.
- `packages/convex-hosting-tanstack-start`: the Vite settings and the server entry that make
  TanStack Start's server build run inside a Convex HTTP action (Convex cannot bundle `node:stream`,
  so pages render with React's Web Stream renderer), the plugin's write of
  `.convex-hosting/server.js` after a server build, and the `convex-auth` session helpers. It knows
  nothing about versions.
- `examples/tanstack-spa`: TanStack Start in SPA mode, served with
  `--not-found-handling single-page-application`.
- `examples/tanstack-ssr`: pages rendered in the `render` of `serveSite`.
- One `README.md` at the repository root, copied into the package at `prepack`.
- An app has `.convex-hosting/` (ignored, written by the CLI and the adapter's plugin) and nothing
  else of ours outside `convex/convex.config.ts` and `convex/http.ts`.
