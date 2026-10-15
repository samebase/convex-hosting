# convex-hosting 0.4: design

The goal: an app on convex-hosting stays a standard TanStack Start app that can move to Cloudflare
Workers with almost no changes. The Convex-specific parts are exactly `convex/http.ts`, the
`src/server.ts` re-export, the `convexSsr()` plugin, and the deploy command.

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
first request that new code serves finds its version in state `ready` and marks it `live`. An older
upload never goes live over a newer one: a version is marked only when no live version was created
after it, so a request still running on replaced code cannot take the site back. Marking a version
live deletes the versions that were live before it, because their code is gone by definition.
Nothing is deleted by the clock alone: deletion runs only at a switch, when a new version becomes
live, so a deployment that gets no request deletes nothing and keeps its version intact for its
first request, whenever it comes. At a switch, a version that never became live is dead too, from a
push that failed, with one exception: a slower deploy whose push has not landed yet. So a never-live
version is deleted at a switch only when it is more than a day old; the day bounds how late a push
may follow its upload, and it is the only time constant in the design.

The precondition: deploys to one deployment do not overlap. When two overlap and the older upload is
pushed last, the component cannot tell its requests from requests still running on replaced code:
its version serves, but it never becomes live, and nothing is deleted until the next deploy. So run
one deploy at a time per deployment; the example workflows queue them, with one `concurrency` group
per deployment.

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
The CLI parses no credential. `--component <name>` names the component instance, `hosting` by
default. The name is Convex's own `app.use(hosting, { name })` option, so the CLI must match it;
Bristol's production used it while hosting 0.3 and 0.4 ran side by side under two names.

1. The CLI chooses a random version id.
2. Production and preview: it runs
   `npx convex deploy --cmd "<command> && convex-hosting upload --dist <dir> --version-id <id> ..."`.
   Both run in the project directory; a build must not change directory. Convex gives the build the
   deployment's URL in `CONVEX_URL` and in one framework variable such as `VITE_CONVEX_URL`, as it
   documents for frontends. Inside the command, `upload`:
   1. collects the files of `<dir>`, honoring `.assetsignore` and following symbolic links as
      Wrangler does (a link to nothing, or to a folder that contains it, is skipped with a message;
      a link to another folder uploads its files under both paths), and computes each file's sha256
      and content type; refuses a file above 25 MiB, Cloudflare's limit per asset (the HTTP action
      that serves a file could not answer more than Convex's 100 MiB response limit anyway); reads
      `_headers` and `_redirects` with Cloudflare's parsers into the version's config;
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

**The site URL.** When the push, and on a first install the upload after it, have ended, the CLI
asks the deployment for its site URL: `npx convex run --inline-query process.env.CONVEX_SITE_URL`,
with the selector of its other calls, which needs only the permission of the first-install probe. It
prints the URL and, when `GITHUB_OUTPUT` is set, appends `url=<site URL>` to that file, so a
workflow step reads it as a step output. The value is the one the deployment gives its own
functions, so it is right for every kind of deployment (production, a preview, development, local,
self-hosted) and is the custom domain when the dashboard's "Override Environment Variables" sets
one; the CLI never builds it from a deployment name.

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
not an inner loop, and Cloudflare's tooling has the same shape. `http.ts` imports
`.convex-hosting/version.js`, which only a deploy writes, and a server-rendered app's `http.ts` also
imports its server build, such as `dist/server/server.js`, which only a build writes. So a fresh
clone cannot push before its first deploy, and that deploy's build needs the deployment's URL, which
`npx convex dev` writes to `.env.local` when it creates the deployment. The first step is
`npx convex dev --skip-push`, a hidden flag of the Convex CLI (1.46): it configures the deployment,
writes `.env.local`, and exits without pushing. Then `convex-hosting deploy --dev` builds, uploads,
writes the version file, and pushes, and from then on `npx convex dev` works as usual. When `dist/`
or `.convex-hosting/` is deleted later, `npx convex dev` fails with a "Could not resolve" error that
names the file, and `deploy --dev` writes both again. Against a local deployment, the upload needs a
running backend, which a Convex CLI call starts only for itself (see the table below). So a fresh
clone starts `npx convex dev` first and keeps it running: its first push fails to resolve the
imports, `deploy --dev` in a second terminal pushes, installs, and uploads, and the running
`npx convex dev` pushes again at the next change under `convex/` (run against an anonymous
deployment on 2026-10-15). A plain `npx convex deploy` from a fresh clone fails to bundle, and from
a checkout that deployed elsewhere it pushes that deploy's id and the site answers 404, which is why
production and previews deploy only through `convex-hosting deploy`. Two things in this loop are
transient and documented, not solved: when a server-rendered app's build changes `dist/server`,
which `http.ts` imports, a running `npx convex dev` pushes before `deploy --dev` has written the new
id, so pages reference files that answer 404 until that run ends; and a production deploy run from
the same checkout writes production's id, which a running `npx convex dev` then pushes to the
development deployment, where that version does not exist, until the next `deploy --dev`. Production
deploys belong in CI or a separate checkout.

The server import names the framework's own output, `../dist/server/server.js` for TanStack Start,
with nothing in between. The adapter declares that module with the type of its own server entry, a
default export with `fetch(request, ...)`, in its types-only `server-build` entry, which `http.ts`
loads with `import type {}`, so `http.ts` typechecks before the first build. The declaration covers
the framework's default output only (`dist/server/server.js`, or `.mjs` without `"type": "module"`);
an app that changes the output folder or the entry name declares its own path with one wildcard
line. The hosting package declares only the version module, which it writes. An app leaves `allowJs`
out of `convex/tsconfig.json`, because with it tsc reads the build instead of the declaration.

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
deploys at once are an overlap, which the precondition rules out: both push and upload, and the last
push serves.

**Browsers.** A page opened before a deploy keeps asking for its hashed files, which the new version
does not have, exactly as on Cloudflare: they answer 404, or the shell on a files-only single-page
app. An app that wants to reload on a new version adds one query that returns the bundled
`versionId` and reloads when its value changes. The README shows it. The component has no part in
it.

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
any page refers to them, and a first install serves no page until its upload ends. `render` is the
Worker script: the code that runs on a miss, with the request in its closure. Its absence is the
files-only Worker, so `serveSite` is the one entry.

`serveSite` calls the component query `route` with the method, the URL, the four request headers
that Cloudflare's handler reads (`If-None-Match`, `Sec-Fetch-Mode`, and the presence of
`Authorization` and `Range`), and `hasUserWorker`. As on Cloudflare, the presence of code decides,
and `hasUserWorker` is Cloudflare's `has_user_worker`: `serveSite` passes `true` with `render` and
`false` without it; the app sets no option. With code, the app is the Worker, and Cloudflare's
routing with a Worker applies: inside the query, Cloudflare's `canFetch` decides whether an asset
answers, a request that does not resolve to a file goes to the app, and `not_found_handling` (the
404 page, the single-page fallback) applies to navigation requests only. Without code, the site is a
Worker without a script, whose router sends every request to the asset handler: the query skips
`canFetch` and runs `handleRequest`, so `not_found_handling` applies to every request, and a missing
hashed file on a single-page app gets the shell with 200. One difference from Cloudflare follows
from Convex's router and is stated, not fixed: an exact app route wins over an asset at the same
path.

The component runs the handler with a fixed compatibility date at or after 2025-04-01, the date from
which Cloudflare treats `Sec-Fetch-Mode: navigate` requests this way; the date is package code, not
configuration. When an asset answers, Cloudflare's `handleRequest` computes the status and headers:
`Cache-Control: public, max-age=0, must-revalidate` (Cloudflare omits it when the request carries
`Authorization` or `Range`, and so do we), `ETag`, 304 for `If-None-Match`, `_headers` rules,
`_redirects`, `html_handling`, and the custom 404 page with its body. The query drops
`CF-Cache-Status`, which describes a cache we do not run, sets `Cache-Control: no-store` on every
404, because the deployment's Cloudflare front caches 404 answers on static paths, and returns the
status, the headers, and the storage URL of the body when the response has one, whatever the status.
`serveSite` fetches that body and returns the response. When the query finds no storage URL for the
entry, or storage answers 404, because a deletion pass removed the file, the answer is 404 with
`Cache-Control: no-store`; any other fetch failure answers 502 with no caching. An app cannot read a
component's storage, so each asset hit costs that one fetch.

When the version does not exist, is still `uploading`, or is `deleting`, `serveSite` answers a 404
response that names the version, with `Cache-Control: no-store`, so a half-installed site answers
404 rather than rendering pages without their files, and the deployment's Cloudflare front, which
caches 404 answers on static paths, does not keep that answer after the upload ends. A `null` asset
means one thing: no asset matched, and `render` answers.

When `route` reports the version in state `ready`, `serveSite` calls `markLive` once, before it
answers. `markLive` marks the version only when no live version was created after it, inside its own
transaction, so a request whose code was replaced, whenever it reaches its lookup or its mark,
cannot make its version newest, and concurrent first requests mark once. That is the only write the
serving path ever makes, once per deploy.

`route` and `markLive` are the component's only public functions, because `serveSite` runs in the
app and an app can call only a component's public functions; clients cannot call them at all. The
CLI calls the other functions, which are internal, with `npx convex run --component`.

The two callbacks that Cloudflare's code takes map to the version's entries: `exists(path)` reads
one index entry and returns its ETag, the sha256 followed by a short hash of the content type, so
that identical bytes stored under two content types stay distinct; `getByETag` returns the content
type of the entry that `exists` found and a placeholder stream, which `serveSite` replaces with the
body. Nothing is added to Cloudflare's headers besides `no-store` on a 404. Long caching of hashed
files is a `_headers` rule, as on Cloudflare.

Other HTTP routes of the app (auth, APIs) win over the site route when they are exact paths or
longer prefixes, by Convex's router rules for the same method.

## Component

Two tables, `versions` and `entries`, in `src/component/schema.ts`; the functions are in
`src/component/lib.ts`.

The time a version became live lives inside the `live` state, so a version cannot carry a live time
without being live; a mark sets it strictly later than the newest live time, so two marks in one
millisecond still order, and live times follow creation order. `deleting` is set before a version's
entries go, so a version half deleted cannot become live. Creation times come from `_creationTime`.
`config` is the JSON of Cloudflare's `AssetConfig` for the version: `html_handling`,
`not_found_handling`, `headers`, `redirects`. It is a string because `redirects.staticRules` has one
field per rule and Convex limits an object to 1,024 fields. A document is limited to 1 MiB, so the
CLI refuses a config above 900 KiB, leaving room for the other fields and the encoding, and names
the file that causes it. An entry keeps its own content type because the type belongs to the path,
not to the bytes: paths with identical bytes share one stored file but keep their own types, and
`route` serves without reading `_storage`.

The package sets one limit of its own, 25 MiB per file, for the reason above. Convex's limits apply:
1 MiB per document, and the transaction limits (16,000 writes, 32,000 documents scanned, 16 MiB read
and written, 8,192 array elements, 4,096 index ranges, argument and result sizes) shape the batches.

## Orderings and timing

Every interleaving worked through for 0.4, what happens, and what checks it. "Component test" is a
convex-test run of the exact order of transactions; "runtime" is a run against a local backend.

| What happens                                                                                                 | Outcome                                                                                                                                         | Checked by                               |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A deploy pushes; the first request arrives                                                                   | The version is marked live; the versions live before it are deleted                                                                             | Component test, runtime                  |
| Two deploys overlap; the pushes land in creation order                                                       | Both complete; the last push's version is marked live at its first request; the other was never live and goes at a later switch when a day old  | Component test (age rule)                |
| Two deploys overlap; the earlier-created one pushes last                                                     | Outside the precondition. Its version serves but is never marked, because the other is newer and live; nothing is deleted until the next deploy | Component test (stale request)           |
| A request on old code is in flight when a push lands, and reaches `markLive` after the new code's first mark | Its version is older than the live one, so the mark is refused; the new version stays live and keeps its files                                  | Component test (stale request)           |
| Two first requests of one version                                                                            | One mark; the second is a no-op                                                                                                                 | Component test                           |
| Two marks in one millisecond                                                                                 | The second is strictly later                                                                                                                    | Component test                           |
| A deploy dies before its push                                                                                | A never-live version; deleted at a later switch when a day old                                                                                  | Component test (age rule)                |
| An upload dies midway                                                                                        | An `uploading` version; same fate; a retry reuses its recorded files                                                                            | Component test, runtime (reuse)          |
| The push is reported as failed but landed                                                                    | The version is `ready` and is marked live at its first request                                                                                  | Inherent; stated                         |
| No request for days, weeks                                                                                   | Nothing is deleted; the first request marks the version live                                                                                    | Inherent: deletion runs only at a switch |
| Many deploys, no requests in between                                                                         | The first request marks the newest; older never-live versions go when a day old, younger ones at the next switch                                | Component test (age rule)                |
| A push lands more than a day after its upload, after another switch                                          | Its version is gone; the site answers 404 naming it; redeploy                                                                                   | Stated                                   |
| An upload borrows a stored file; a switch deletes the lending version                                        | The file survives: files go only when unreferenced, a day old, and already unreferenced when the chain started                                  | Component test (sweep order)             |
| Two switches during one upload                                                                               | The borrowed file can go; `recordFiles` says so; a retry works                                                                                  | Stated                                   |
| A first request reaches a version while its entries are being deleted in pages                               | The version is `deleting`: 404, no mark                                                                                                         | Component test                           |
| Documents share a creation time at a page boundary                                                           | The cursor carries the ids seen at that time; none is skipped                                                                                   | Component test (crafted cursor)          |
| First install: the component does not exist yet                                                              | Push first, then upload; 404 until the upload ends                                                                                              | Runtime (both flows)                     |
| Two first installs at once                                                                                   | Outside the precondition. Both push and upload; the last push serves                                                                            | Stated                                   |
| Two commands from one checkout at once                                                                       | They overwrite each other's build output and version file                                                                                       | Stated, unsupported                      |
| A production deploy from a checkout where `npx convex dev` runs                                              | Production's id is pushed to development until the next `deploy --dev`                                                                          | Stated                                   |
| `deploy --dev` against an anonymous local deployment without `npx convex dev`                                | Each Convex CLI call starts and stops its own backend; the upload fails with `fetch failed`                                                     | Runtime; stated in the README            |

Not reproducible in the test runtime and not yet run against a cloud deployment: two real pushes in
a chosen order, a preview deployment, an old HTTP action kept running across a push. A smoke script
against a disposable preview deployment, run by hand with a deploy key before a release, is the
place for those.

## Stated, not solved

- Deploys to one deployment do not overlap. When two overlap and the older upload is pushed last,
  the component cannot tell its requests from requests still running on replaced code, so its
  version serves but is never marked live, each of its requests calls `markLive` for nothing, and
  nothing is deleted until the next deploy.
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
- No lock, no heartbeat, no cron, no call after the push besides the read of the site URL: a version
  is deleted only after another version has served in its place. A one-day age bounds garbage from
  failed deploys; it decides nothing about what is served.
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
- **A compare-and-set on the newest live time that the request's lookup saw.** It closed the gap
  between a request's lookup and its mark, not the gap between the request's start and its lookup: a
  request on replaced code whose lookup came after the new code's first mark passed it, made its old
  version newest, and `collect` deleted the new version's files. Creation order decides the mark
  instead, and deploys that do not overlap are the precondition.
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
- **`serveAsset`, an exported first step of `serveSite` that returned the file or `null`, for a
  route that did something else on a miss.** That something else is `render`: it is the Worker
  script, and its absence is the files-only Worker, so a second entry only gave `hasUserWorker` a
  second source. `serveSite` is the one entry.
- **Post-deploy verification through a version meta tag.** Wrangler has none; the push succeeds or
  fails, and the tag forced a Vite plugin and a server wrapper that existed only for it.
- **A push-time lock check through Convex's schema validation (a literal id in the schema).** The
  live schema controls every write, so the next deploy could never write its own id into the row.
- **A subshell so that a build command may change directory.** Shell-specific; the build runs in the
  project directory instead.
- **A `size` field on entries.** A matching sha256 already proves the bytes are the same.
- **An app-side script that builds the app once before `npx convex dev`** (Bristol's
  `scripts/ensure-server-build.ts`), because `convex/http.ts` imported `dist/server/server.js`.
  Every server-rendered app would copy it, and a full build blocked the first push. The import of
  `dist/server/server.js` stays; the fresh-clone order replaces the script:
  `npx convex dev --skip-push`, then `convex-hosting deploy --dev`, whose build is the first.
- **The `init` server placeholder plus the plugin's re-export.** `convex-hosting init` wrote
  `.convex-hosting/server.js` as a placeholder whose `fetch` answered 503, and `convexSsr()`
  overwrote it after each server build with a re-export of the build's entry chunk, found from the
  working directory. It took four fixes in one day, and after `dist/` was deleted the re-export
  stayed and pointed at nothing, so `npx convex dev` failed on a file the app never wrote (PR 35).
  Replaced by the direct import of `dist/server/server.js` and the `npx convex dev --skip-push`
  first step, which leave no generated file in between that can go stale.
- **Wrapping the Convex Auth session lines in this package.** The hosting package must not depend on
  Convex Auth, and the lines are Convex Auth's own API; a helper for HTTP actions belongs upstream.

## What an app writes

One row per piece of a TanStack Start app with Convex Auth cookie sessions on this host, with its
owner since `@samebase/convex-hosting` 0.7.0 and `@samebase/convex-hosting-tanstack-start` 0.4.0.

| Piece                                                     | Owner                                                                                                                        | Why                                                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File serving, and `no-store` on rendered pages and misses | Hosting package: `serveSite`                                                                                                 | The Cloudflare front caches answers on static-looking paths of every site                                                                                                  |
| The server entry import and `fetch(request, { context })` | App: `import server from "../dist/server/server.js"`, called in `serveSite`'s `render`                                       | Convex bundles what `http.ts` imports, and the import names the build's own output; `fetch` is TanStack's `RequestHandler<Register>`, so `context` has the registered type |
| The type of `dist/server/server.js`                       | Adapter: types-only `server-build` entry, loaded by `import type {}`; the app leaves `allowJs` out of `convex/tsconfig.json` | The adapter knows its build's entry; with `allowJs` tsc reads the file instead                                                                                             |
| `src/server.ts`                                           | App: one line that re-exports the adapter's `server`                                                                         | Start builds its server entry from a file in the app's `src/`                                                                                                              |
| `convexSsr()`                                             | Adapter, added to the app's `vite.config.ts`                                                                                 | The Vite config is the app's; the settings are the adapter's                                                                                                               |
| The `requestContext` type                                 | Adapter `convex-auth`, on the `Register` of `@tanstack/react-start`; `convex/http.ts` loads the entry with `import type {}`  | The token is the Convex Auth session's, Start reads that `Register`, and the `convex/` folder is its own program, so it loads the registration itself                      |
| `expectAuth`                                              | App, in `getRouter`                                                                                                          | The app creates the Convex client                                                                                                                                          |
| The root `beforeLoad`                                     | Adapter `convex-auth`: `sessionBeforeLoad`                                                                                   | The same lines in every app with this session                                                                                                                              |
| The provider, plus the release of `expectAuth`            | Adapter `convex-auth`: `SessionProvider`                                                                                     | Convex's provider never releases `expectAuth` for a signed-out visitor                                                                                                     |
| The gate                                                  | Adapter `convex-auth`: `redirectWithoutSession` and `RedirectWithoutSession`; the app gives the redirect options             | Only the server render has the cookie; the browser follows the provider                                                                                                    |
| The session state in components                           | Adapter `convex-auth`: `SignedIn` and `SignedOut`                                                                            | Convex's provider reports loading during the server render and the hydration                                                                                               |
| The cookie session lines in `http.ts`                     | Convex Auth's own API, written in the app                                                                                    | A helper for HTTP actions belongs upstream                                                                                                                                 |
| The `/auth/*` routes                                      | Convex Auth's own API (`setupConvexAuthServer`), registered by the app                                                       | The handlers are Convex Auth's; the paths are the app's                                                                                                                    |
| The Convex Auth setup files                               | App, with Convex Auth's own API                                                                                              | The providers and the users table are the app's                                                                                                                            |
| Deploy and preview commands                               | Hosting package: `convex-hosting deploy`, in the app's scripts and CI                                                        | The upload must run between the build and the push                                                                                                                         |

## What the packages export

Every export, with who uses it and why it exists. An export with no user in the examples, Bristol,
or ChessMerge goes; the list is checked at every release. At 0.8.0 and 0.5.0 that removed
`serveAsset` and `useSignedIn`.

| Export                                                                    | Used by                                              | Why                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hosting `serveSite`                                                       | `convex/http.ts` of every app                        | The one entry: files, then `render`, which is the Worker script; its absence is the files-only Worker                                                                 |
| hosting `convex.config`                                                   | `convex/convex.config.ts` of every app               | Convex's component definition, for `app.use`                                                                                                                          |
| hosting `_generated/component.js` (types)                                 | The generated `api.d.ts` of every app                | Convex's codegen imports it for the component's API type                                                                                                              |
| CLI `deploy --build --dist [--dev \| --preview-name]`                     | App scripts and CI                                   | The upload must run between the build and the push, with the deployment chosen by the same flags as Convex's CLI                                                      |
| CLI `--html-handling`, `--not-found-handling`                             | SPA example; ChessMerge (`none`)                     | Cloudflare's own asset settings, stored with the version                                                                                                              |
| CLI `--component`                                                         | None today                                           | Convex's own `app.use(hosting, { name })` option; the CLI must match it; Bristol's production used it while hosting 0.3 and 0.4 ran under two names                   |
| CLI `upload`                                                              | `deploy` itself, inside `npx convex deploy --cmd`    | The step after the build has to be a program that a shell can call                                                                                                    |
| adapter `vite`: `convexSsr()`                                             | `vite.config.ts` of server-rendered apps             | The `ssr` environment settings that make Start's server build run in Convex's runtime                                                                                 |
| adapter `server`                                                          | `src/server.ts` of server-rendered apps              | Start's handler with React's Web Stream renderer, typed as TanStack's `RequestHandler<Register>`, so `fetch(request, { context })` takes the app's registered context |
| adapter `server-build` (types)                                            | `convex/http.ts` of server-rendered apps             | The type of the built server module, derived from `server`                                                                                                            |
| adapter `convex-auth`: `sessionBeforeLoad`                                | The root route                                       | The same `beforeLoad` in every app with cookie sessions                                                                                                               |
| adapter `convex-auth`: `SessionProvider`                                  | The root component                                   | Convex Auth's provider with the server token, plus the release of `expectAuth` for a signed-out visitor                                                               |
| adapter `convex-auth`: `redirectWithoutSession`, `RedirectWithoutSession` | The `_authed` layout                                 | The server render has the cookie; the browser follows the provider; two moments, two pieces                                                                           |
| adapter `convex-auth`: `SignedIn`, `SignedOut`                            | Bristol's header and menus                           | Convex's provider reports loading during the server render and the hydration; these wait for the answer                                                               |
| adapter `convex-auth`: `useSignOutSession`                                | The header's sign-out in the SSR example and Bristol | Convex Auth's `signOut()` resolves when the cookie route failed; this asks the route first, then clears the client, then reloads                                      |

## Repository

- `packages/convex-hosting`
  - `src/component`: `schema.ts`, `lib.ts`, `convex.config.ts`, and its generated files.
  - `src/client`: `serveSite` and the shipped declaration of the version module.
  - `src/cli`: the `convex-hosting` command: `deploy`, and `upload`, the inner step that
    `npx convex deploy --cmd` has to call as a program.
  - `src/workers-shared`: Cloudflare's asset worker and its tests, copied by
    `scripts/sync-workers-shared.ts` from cloudflare/workers-sdk at the commit in `UPSTREAM`. Only
    the sync script changes it.
  - Whatever `npx convex codegen --component-dir ./src/component` needs to run against an anonymous
    local deployment, and nothing more; `CONTRIBUTING.md` says what that is. No example is involved.
- `packages/convex-hosting-tanstack-start`: the Vite settings and the server entry that make
  TanStack Start's server build run inside a Convex HTTP action (Convex cannot bundle `node:stream`,
  so pages render with React's Web Stream renderer), the types-only `server-build` entry that
  declares the build's server module, and the `convex-auth` session helpers. It knows nothing about
  versions.
- `examples/tanstack-spa`: TanStack Start in SPA mode, served with
  `--not-found-handling single-page-application`.
- `examples/tanstack-ssr`: pages rendered in the `render` of `serveSite`.
- One `README.md` at the repository root, copied into the package at `prepack`.
- An app has `.convex-hosting/` (ignored, written by the CLI) and nothing else of ours outside
  `convex/convex.config.ts` and `convex/http.ts`.
