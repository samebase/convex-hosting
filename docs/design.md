# convex-hosting 0.4: design

The goal: an app on convex-hosting stays a standard TanStack Start app that can move to Cloudflare
Workers with almost no changes. The Convex-specific parts are exactly `convex/http.ts`, the
`convexSsr()` plugin, `app.use(hosting)`, and the deploy command: the files in which the example
differs from [the same app on Workers](#the-same-app-on-workers).

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
carries the asset version it was built with, its id and its files, as a Worker carries its asset
manifest: each path's content hash, content type, and stored file. The push is the switch. There is
no pointer that a second step must move, so there is no moment when new code serves old files. A
request reads no database: the HTTP action answers from the files in its own code, and downloads the
bytes of a file from storage.

After its push, the CLI marks its version `live`, with `markLive` in the component. An older upload
never goes live over a newer one: a version is marked only when no live version was created after
it. Marking a version live deletes the versions that were live before it, because their code is gone
by definition. Nothing is deleted by the clock alone: deletion runs only at a switch, when a new
version becomes live, so a version stays intact until a newer one has served. At a switch, a version
that never became live is dead too, from a push that failed, with one exception: a slower deploy
whose push has not landed yet. So a never-live version is deleted at a switch only when it is more
than a day old; the day bounds how late a push may follow its upload, and it is the only time
constant in the design.

The precondition: deploys to one deployment do not overlap. When two overlap and the older upload is
pushed last, its mark is refused: its version serves, but it never becomes live, and nothing is
deleted until the next deploy. If its mark lands before the newer version's, both are marked in
turn, and the newer version's mark deletes the rows of the version that serves; its stored files
stay until the next deploy's switch. So run one deploy at a time per deployment; the example
workflows queue them, with one `concurrency` group per deployment.

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
      that serves a file could not answer more than Convex's 100 MiB response limit anyway), and
      more than 100,000 files, Cloudflare's limit per Worker version on its Paid plan; reads
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
      every file the crashed run recorded, through step 3;
   6. reads the storage URL of every entry, with the deployment's `CONVEX_CLOUD_URL`, through inline
      queries in the component (`npx convex run --component <name> --inline-query`), which run
      whatever release of this package the component is, so an upgrade's upload works before its
      push installs the new functions; then writes `.convex-hosting/version.js` with the version's
      `assets`: the id and the files (see Serve), in the CLI's state folder at the project root,
      like Wrangler's `.wrangler/`. It writes a temporary file and renames it, so a running
      `npx convex dev` never reads half of it; the folder carries its own `.gitignore`, so nothing
      of it reaches git and no tool writes into `convex/`. The file is a build artifact that
      `http.ts` imports, as a server-rendered app's `http.ts` already imports its server build; the
      package ships the declaration of that module (an ambient wildcard module in a script `.d.ts`
      that the package's types entry references), so a fresh clone typechecks with nothing added.
      Then, still inside `npx convex deploy`, Convex bundles `convex/` with the new id and pushes.
      The push is the switch, and the command ends.
3. `--dev`: the same steps, in one process: the CLI runs the build itself (Vite reads the
   deployment's URL from `.env.local`, so no nesting is needed), uploads, writes the version file,
   and pushes with `npx convex run --push`.

**The mark.** When the last push has ended, the CLI calls `markLive` for its version, with
`npx convex run --component <name> lib:markLive`, as it calls the upload's functions. A failure is
reported, and the deploy succeeds: nothing is deleted until a later version is marked, so the cost
is old files kept until the next deploy.

**The site URL.** When the push, and on a first install the upload and the push after it, have
ended, the CLI asks the deployment for its site URL:
`npx convex run --inline-query process.env.CONVEX_SITE_URL`, with the selector of its other calls,
which needs only the permission of the first-install probe. It prints the URL and, when
`GITHUB_OUTPUT` is set, appends `url=<site URL>` to that file, so a workflow step reads it as a step
output. The value is the one the deployment gives its own functions, so it is right for every kind
of deployment (production, a preview, development, local, self-hosted) and is the custom domain when
the dashboard's "Override Environment Variables" sets one; the CLI never builds it from a deployment
name.

**First install.** The component's functions exist only after a push, and a new preview deployment
exists only once `npx convex deploy` has created it, which happens before it runs the command. So
the upload decides. Its first call is a probe, `npx convex run --component <name> --inline-query`,
because that path of the Convex CLI looks the component up before it runs anything and prints the
exact message `Component path "<name>" was not found.` when the deployment does not have it (a
function run against a missing component answers only a generic server error, which must not count).
On that exact message, the production and preview upload writes a version file without files and a
marker file in `.convex-hosting/` and exits without uploading, so the push that follows installs the
component; `deploy` sees the marker after `npx convex deploy` returns, runs the upload then, and
pushes again with `npx convex deploy`. For `--dev`, in one process, it writes the version file,
pushes, uploads, and pushes again. Until the second push, the site answers 404 naming the version
(see Serve). Once per deployment.

**The development loop.** Local work uses Vite's dev server, with hot reload, against the
development deployment's URL, while `npx convex dev` pushes function changes, as in any Convex app.
`convex-hosting deploy --dev` is a one-shot command for when the development deployment itself
should serve the current build. There is no watch mode: a build, an upload, and a push per change is
not an inner loop, and Cloudflare's tooling has the same shape. `http.ts` imports
`.convex-hosting/version.js`, which only a deploy writes, and a server-rendered app's `http.ts` also
imports its server build, such as `dist/server/server.js`, which only a build writes. So a fresh
clone cannot push before its first deploy, and that deploy's build needs the deployment's URL, which
`npx convex dev` writes to `.env.local` when it creates the deployment. The first run is two
terminals: `npx convex dev`, which configures the deployment, writes `.env.local`, fails its first
push on the version file, and keeps running; then `convex-hosting deploy --dev` in the other, which
builds, uploads, writes the version file, and pushes. From then on `npx convex dev` works as usual.
When `dist/` or `.convex-hosting/` is deleted later, `npx convex dev` fails with a "Could not
resolve" error that names the file, and `deploy --dev` writes both again. Against a local
deployment, the upload needs a running backend, which a Convex CLI call starts only for itself (see
the table below). So a fresh clone starts `npx convex dev` first and keeps it running: its first
push fails to resolve the imports, `deploy --dev` in a second terminal pushes, installs, and
uploads, and the running `npx convex dev` pushes again at the next change under `convex/` (run
against an anonymous deployment on 2026-10-15). A plain `npx convex deploy` from a fresh clone fails
to bundle, and from a checkout that deployed elsewhere it pushes that deploy's id and the site
answers 404, which is why production and previews deploy only through `convex-hosting deploy`. Two
things in this loop are transient and documented, not solved: when a server-rendered app's build
changes `dist/server`, which `http.ts` imports, a running `npx convex dev` pushes before
`deploy --dev` has written the new id, so pages reference files that answer 404 until that run ends;
and a production deploy run from the same checkout writes production's id, which a running
`npx convex dev` then pushes to the development deployment, where that version does not exist, until
the next `deploy --dev`. Production deploys belong in CI or a separate checkout.

The server import names the framework's own output, `../dist/server/server.js` for TanStack Start,
with nothing in between. The adapter declares that module as a default export with `fetch(request)`,
the shape of the app's `src/server.ts`, in its types-only `server-build` entry, which `http.ts`
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
command reports as failed may still have landed; the site then serves the new version, which stays
`ready` because the CLI sent no mark, and the next deploy is a normal one: its mark deletes the
versions before it. No resume logic. Two first deploys at once are an overlap, which the
precondition rules out: both push and upload, and the last push serves.

**Browsers.** A page opened before a deploy keeps asking for its hashed files, which the new version
does not have, exactly as on Cloudflare: they answer 404, or the shell on a files-only single-page
app. An app that wants to reload on a new version adds one query that returns the bundled
`versionId` and reloads when its value changes. The README shows it. The component has no part in
it.

## Serve

The app's `convex/http.ts` calls `routeAll`, which routes the site's action, one `pathPrefix: "/"`
route per method Convex routes, because every request reaches a Cloudflare Worker's asset router: a
file answers GET, another method on a file answers 405, and a request that matches no file goes to
the app's server. A server-rendered app with Convex Auth adds one exact `POST` route per `/auth`
path: the Convex Auth component holds the `/auth` prefix, where it serves the key set, and Convex
picks the longest matching prefix, so only an exact route reaches the app there. Convex answers
`HEAD` through the `GET` handler and drops the body.

```ts
import { routeAll } from "@samebase/convex-hosting";
import { assets } from "../.convex-hosting/version.js";

routeAll({ http, assets, worker: server });
```

Every input is named, after Cloudflare where Cloudflare has a name: `assets` is the static assets of
Workers Static Assets (its `assets` setting and `ASSETS` binding), and `worker` is the Worker script
(`has_user_worker`, `run_worker_first`). The export is not `site`, the setting of Workers Sites,
which Cloudflare deprecated for Static Assets. The file stays `version.js`, since it holds one
version, Cloudflare's unit of a deploy.

`serveSite` answers with the file when one matches. Otherwise it answers with the page that the
optional `worker.fetch()` returns, else 404, both with `Cache-Control: no-store`; the page keeps
every other header, several `Set-Cookie` included. Measured on 2026-10-14: the deployment's
Cloudflare front keeps `no-store` for a path without an extension and answers
`public, max-age=14400` with `cf-cache-status: BYPASS` for a path with one, so the browser, not the
edge, caches a 404 for a missing script for four hours. The deploy order prevents that case: a
version's files exist before any page refers to them, and a first install serves no page until its
upload ends. `worker` is the Worker script, the object with `fetch(request)` that the server entry
exports: the code that runs on a miss. Its absence is the files-only Worker, so `serveSite` is the
one entry.

`serveSite` runs Cloudflare's handler in the action, on the request as it came, against the site's
files, so a request calls no function of the component. As on Cloudflare, the presence of code
decides, and `hasUserWorker` is Cloudflare's `has_user_worker`: `serveSite` passes `true` with
`worker` and `false` without it; the app sets no option. With code, the app is the Worker, and
Cloudflare's routing with a Worker applies: Cloudflare's `canFetch` decides whether an asset
answers, a request that does not resolve to a file goes to the app, and `not_found_handling` (the
404 page, the single-page fallback) applies to navigation requests only. Without code, the site is a
Worker without a script, whose router sends every request to the asset handler: `serveSite` skips
`canFetch` and runs `handleRequest`, so `not_found_handling` applies to every request, and a missing
hashed file on a single-page app gets the shell with 200. One difference from Cloudflare follows
from Convex's router and is stated, not fixed: an exact app route wins over an asset at the same
path.

The handler runs with a fixed compatibility date at or after 2025-04-01, the date from which
Cloudflare treats `Sec-Fetch-Mode: navigate` requests this way; the date is package code, which the
CLI writes into each site's config, not configuration. When an asset answers, Cloudflare's
`handleRequest` computes the status and headers: `Cache-Control: public, max-age=0, must-revalidate`
(Cloudflare omits it when the request carries `Authorization` or `Range`, and so do we), `ETag`, 304
for `If-None-Match`, `_headers` rules, `_redirects`, `html_handling`, and the custom 404 page with
its body. Cloudflare's own cases for `html_handling` and path encoding (the test-cases files of
`fixtures/workers-shared-asset-config` in workers-sdk, copied by the same sync script as the
handler) run through the action's handler in `src/client/answer.test.ts`, with each case's files as
a site's manifest. Cloudflare's integration fixtures for static assets
(`fixtures/workers-with-assets-only` in workers-sdk, copied at the same pinned commit with their
`public/` folders, their imports pointed at this package) run against the whole path an app takes:
our implementation of the helper they import to start `wrangler dev` starts an anonymous local
Convex deployment, deploys the fixture's assets with `convex-hosting deploy --dev`, and returns the
site's address. `scripts/fixtures-expected-failures.json` lists each test that fails by a stated
difference from Cloudflare, and the run fails when the list and the outcome disagree. `serveSite`
drops `CF-Cache-Status`, which describes a cache we do not run, sets `Cache-Control: no-store` on
every 404, because the deployment's Cloudflare front caches 404 answers on static paths, and, when
the response has a body, downloads the file from its storage URL. When storage answers 404, because
a deletion pass removed the file, the answer is 404 with `Cache-Control: no-store`; any other fetch
failure answers 502 with no caching. An app cannot read a component's storage, so each answer with a
body costs that one download, which Convex counts as a function call; a redirect, a 304, a 405, and
a 404 without a page download nothing.

The site's `files` are `null` in the code that a first install pushes before its upload: `serveSite`
then answers 404 naming the version, with `Cache-Control: no-store`, without calling `worker`, so a
half-installed site answers 404 rather than rendering pages without their files. The storage URLs
name the deployment they came from, so when the site's `cloudUrl` is not the deployment's
`CONVEX_CLOUD_URL` (a version file that a deploy elsewhere wrote, pushed by a running
`npx convex dev`), it answers 404 naming both, without rendering. A site of another format, which
only another release writes, answers 500 and asks for a deploy. The deployment's Cloudflare front
keeps `no-store` for a path without an extension and gives a path with one a four-hour browser
`max-age` anyway; the deploy order keeps that moot, because no page refers to a file that is not
uploaded yet. A `null` asset means one thing: no asset matched, and `worker` answers.

The serving path calls no function of the component and writes nothing, so `routeAll` does not take
the component. Every function of the component is internal, and the CLI calls each with
`npx convex run --component`. `markLive` marks the version only when no live version was created
after it, inside its own transaction, and a repeated mark changes nothing. It never throws: it
answers `marked`, `live`, `superseded`, `uploading`, `deleting`, or `missing`, and the CLI reports
the last four.

The two callbacks that Cloudflare's code takes map to the site's manifest: `exists(path)` finds the
path's entry and returns its ETag, the content hash, as on Cloudflare; `getByETag` returns the
content type of the entry that `exists` found and a placeholder stream, which `serveSite` replaces
with the body. Nothing is added to Cloudflare's headers besides `no-store` on a 404. Long caching of
hashed files is a `_headers` rule, as on Cloudflare.

**The site's files.** The manifest is Cloudflare's asset manifest, and Cloudflare's own reader
(`asset-worker/src/assets-manifest.ts`, vendored) searches it: a 20-byte header, then one 40-byte
entry per path, sorted by the path hash, the first 16 bytes of the SHA-256 of the path. The CLI
(`src/cli/manifest.ts`) encodes it as Miniflare does for `wrangler dev`. The content hash covers the
bytes and the content type, as Cloudflare's covers the bytes and the extension, so the same bytes
under two types have two ETags. The tail, which Cloudflare leaves zero, holds the index of the
storage URL (a big-endian u32) and of the content type (a big-endian u16, `0xffff` for none). Convex
modules carry no binary data, so the manifest is a base64 string, decoded once per request with
Convex's native `Uint8Array.fromBase64`. The storage URLs differ only in a key, so the start and the
end that they share are written once, and the keys are one string of fixed width: Convex evaluates
the module for every request, and an array of 100,000 strings cost 5 ms and 9 MB more than that one
string. Measured on a cloud deployment on 2026-11-10, against 3.8 ms for an empty action: 4.2 ms per
request at 10,000 files (a 0.9 MB module), 7.5 ms at 100,000 (8.9 MB), where the assets take about 7
MB of the 64 MB that an action has, which the app's `worker` shares.

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
not to the bytes: paths with identical bytes share one stored file but keep their own types, and the
site's manifest carries each type, so serving reads no `_storage` metadata. Serving does not read
`config` either; it makes a retried upload of the same id refuse another config.

The package sets two limits of its own, Cloudflare's: 25 MiB per file, for the reason above, and
100,000 files per site, the most that the site's files were measured with in the pushed code.
Convex's limits apply: 1 MiB per document, and the transaction limits (16,000 writes, 32,000
documents scanned, 16 MiB read and written, 8,192 array elements, 4,096 index ranges, argument and
result sizes) shape the batches.

## Orderings and timing

Every interleaving worked through for 0.4, what happens, and what checks it. "Component test" is a
convex-test run of the exact order of transactions; "runtime" is a run against a local backend.

| What happens                                                                                   | Outcome                                                                                                                                                                                                                                                                       | Checked by                               |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A deploy pushes; the CLI marks its version                                                     | The version is marked live; the versions live before it are deleted                                                                                                                                                                                                           | Component test, runtime                  |
| Two deploys overlap; the pushes land in creation order                                         | Both complete; the last push's version is marked live by its deploy's mark; the other was never live and goes at a later switch when a day old                                                                                                                                | Component test (age rule)                |
| Two deploys overlap; the earlier-created one pushes last                                       | Outside the precondition. Its version serves but is never marked, because the other is newer and live; nothing is deleted until the next deploy. If its mark lands first, the newer version's mark deletes its rows, and its stored files stay until the next deploy's switch | Component test (stale request)           |
| A mark for an older version comes after the new version was marked, from an overlapping deploy | Its version is older than the live one, so the mark answers `superseded`; the new version stays live and keeps its files                                                                                                                                                      | Component test, CLI test                 |
| Two marks of one version                                                                       | One mark; the second answers `live`                                                                                                                                                                                                                                           | Component test                           |
| Two marks in one millisecond                                                                   | The second is strictly later                                                                                                                                                                                                                                                  | Component test                           |
| A deploy dies before its push                                                                  | A never-live version; deleted at a later switch when a day old                                                                                                                                                                                                                | Component test (age rule)                |
| An upload dies midway                                                                          | An `uploading` version; same fate; a retry reuses its recorded files                                                                                                                                                                                                          | Component test, runtime (reuse)          |
| The push is reported as failed but landed                                                      | The version serves, `ready`, since the CLI sent no mark; the next deploy's mark deletes the versions before it                                                                                                                                                                | Inherent; stated                         |
| No request for days, weeks                                                                     | Nothing changes: the deploy marked its version, and deletion waits for the next mark                                                                                                                                                                                          | Inherent: deletion runs only at a switch |
| Many deploys in a row                                                                          | Each deploy marks its version; the one before goes at that mark, never-live versions when a day old                                                                                                                                                                           | Component test (age rule)                |
| A push lands more than a day after its upload, after another switch                            | Its files are gone: pages render, and its files answer 404 from storage; redeploy                                                                                                                                                                                             | Stated                                   |
| An upload borrows a stored file; a switch deletes the lending version                          | The file survives: files go only when unreferenced, a day old, and already unreferenced when the chain started                                                                                                                                                                | Component test (sweep order)             |
| Two switches during one upload                                                                 | The borrowed file can go; `recordFiles` says so; a retry works                                                                                                                                                                                                                | Stated                                   |
| A request on replaced code reaches a version while it is being deleted                         | Its files answer 404 from storage; a mark answers `deleting`                                                                                                                                                                                                                  | Component test, client test              |
| Documents share a creation time at a page boundary                                             | The cursor carries the ids seen at that time; none is skipped                                                                                                                                                                                                                 | Component test (crafted cursor)          |
| The CLI's mark fails                                                                           | Reported; the deploy succeeds; nothing is deleted until the next deploy's mark                                                                                                                                                                                                | CLI test                                 |
| First install: the component does not exist yet                                                | Push a site without files, upload, push the site; 404 naming the version until the second push                                                                                                                                                                                | CLI test, runtime (both flows)           |
| Two first installs at once                                                                     | Outside the precondition. Both push and upload; the last push serves                                                                                                                                                                                                          | Stated                                   |
| Two commands from one checkout at once                                                         | They overwrite each other's build output and version file                                                                                                                                                                                                                     | Stated, unsupported                      |
| A production deploy from a checkout where `npx convex dev` runs                                | Production's site is pushed to development, which answers 404 naming production's deployment until the next `deploy --dev`                                                                                                                                                    | Client test; stated                      |
| `deploy --dev` against an anonymous local deployment without `npx convex dev`                  | Each Convex CLI call starts and stops its own backend; the upload fails with `fetch failed`                                                                                                                                                                                   | Runtime; stated in the README            |

Not reproducible in the test runtime and not yet run against a cloud deployment: two real pushes in
a chosen order, a preview deployment, an old HTTP action kept running across a push. A smoke script
against a disposable preview deployment, run by hand with a deploy key before a release, is the
place for those.

## Stated, not solved

- Deploys to one deployment do not overlap. When two overlap and the older upload is pushed last,
  its mark is refused, so its version serves but is never marked live, and nothing is deleted until
  the next deploy. If its mark lands first, the newer version's mark deletes the rows of the version
  that serves; serving reads no rows, and its stored files stay until the next deploy's switch.
- An upload that took a stored file from `knownFiles` loses it only if two switches happen during
  that one upload; it fails with a message that says so, and a retry works.
- No `run_worker_first`, no `base_path`, no selectable compatibility date: an app that needs its
  route to win over an asset registers an exact route or a longer prefix.
- No upload retry: a transient storage failure fails the deploy, and the next deploy reuses every
  file the failed one recorded.

## Not here, and why

- No live pointer that a command moves, no `activate`, no `getLiveVersion`: the pushed code carries
  its version, and the CLI marks it after the push.
- No lock, no heartbeat, no cron, no call after the push besides the read of the site URL and the
  mark: a version is deleted only after another version has served in its place. A one-day age
  bounds garbage from failed deploys; it decides nothing about what is served.
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

- **A component query per request (`route`, 0.4 to 0.14).** An HTTP action reads the database only
  through a query, so every request cost two function calls, and an answer with a body a third, its
  download. On samebase.com in one billing period, `route` ran 109,000 times for 72,000 site
  requests and 35,000 session refreshes, which the `/auth` exact routes sent through the site's
  action and which never match a file. The pushed code now carries the site's files.
- **Marking live once per isolate, from the serving code.** Convex evaluates the HTTP module for
  every request: on a cloud deployment on 2026-11-04, a module-level counter read 1 on every one of
  52 requests, 40 of them concurrent, while the module's own random id stayed the same. A
  module-level flag would have called `markLive` on every request.
- **A mark request to the served code, with a per-version token (built for 0.15, cut before its
  release).** After the push, the CLI sent the site a request with a random token from the version
  file, and the code that answered marked its own version, so a mark proved which code served. It
  cost about 150 lines: the token, a branch in every app's HTTP action, a public function, and the
  reading of the answer. It protected one case, already outside the precondition: two overlapping
  deploys whose pushes land in the reverse of creation order within about a second, with the marks
  in the other order. The CLI now calls `markLive` itself; in that case the newer version's mark
  deletes the rows of the version that serves, serving reads no rows, and the stored files stay
  until the next deploy's switch.
- **Marking live on a random share of requests.** It kept the mark in the serving code for about one
  call per hundred requests, but a site with little traffic would keep its old versions for days,
  and every request would pay the draw.
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
  route that did something else on a miss.** That something else is `worker`: it is the Worker
  script, and its absence is the files-only Worker, so a second entry only gave `hasUserWorker` a
  second source. `serveSite` is the one entry.
- **The session lines in `convex/http.ts` (adapter 0.2.0 to 0.5.0).** Vite's dev server never ran
  them, so development rendered every page without the session, and a loader whose query needs the
  user failed there (issue 40). They moved into `src/server.ts`, which every host calls.
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

## The same app on Workers

`examples/tanstack-ssr-workers` is `examples/tanstack-ssr` deployed as a Cloudflare Worker with
static assets, with Convex still the backend. The diff between the two folders, committed as
`examples/tanstack-ssr-workers.patch`, is the definition of what is Convex-specific. CI writes it
again from the committed folders with `git diff-tree -p --full-index` and fails when it differs from
the committed file; `pnpm run examples:diff` refreshes it. It covers `convex/http.ts`,
`app.use(hosting)` in `convex/convex.config.ts` (the generated API that follows it is left out),
`src/server.ts`, `vite.config.ts`, `package.json`, and the Worker's `wrangler.jsonc`, and leaves out
the READMEs. `src/server.ts` is the same file on both hosts, the `/auth` routes and the session
lines around the server entry, but for one line: the entry it wraps, the adapter's on Convex and
TanStack Start's default on the Worker. Vite's dev server calls that file too, so development
renders with the session on both hosts. The build's prerender runs through it as well: its requests
carry the header that `tanstackStart({ prerender: { headers } })` sends and get `undefined` as the
token, so `SignedIn` and `SignedOut` wait for the browser on the prerendered page instead of saying
signed out.

## What an app writes

One row per piece of a TanStack Start app with Convex Auth cookie sessions on this host, with its
owner since `@samebase/convex-hosting` 0.7.0 and `@samebase/convex-hosting-tanstack-start` 0.4.0.
The session pieces moved from the adapter's `convex-auth` entry to the auth package,
`@samebase/convex-auth-tanstack-start`, at its 0.1.0 and the adapter's 0.11.0.

| Piece                                                     | Owner                                                                                                                        | Why                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| File serving, and `no-store` on rendered pages and misses | Hosting package: `routeAll`                                                                                                  | The Cloudflare front caches answers on static-looking paths of every site                                                                        |
| The server entry import and `fetch(request)`              | App: `import server from "../dist/server/server.js"`, called in `routeAll`'s `worker` and by the `/auth` routes              | Convex bundles what `http.ts` imports, and the import names the build's own output                                                               |
| The type of `dist/server/server.js`                       | Adapter: types-only `server-build` entry, loaded by `import type {}`; the app leaves `allowJs` out of `convex/tsconfig.json` | The declaration is the shape of the app's `src/server.ts`, `{ fetch(request) }`; with `allowJs` tsc reads the file instead                       |
| `src/server.ts`                                           | App: the session lines and the `/auth` routes around the adapter's `server`; one re-export line without sessions             | Start builds its server entry from a file in the app's `src/`, and Vite's dev server calls that file, so what runs there runs in development too |
| `convexSsr()`                                             | Adapter, added to the app's `vite.config.ts`                                                                                 | The Vite config is the app's; the settings are the adapter's                                                                                     |
| The `requestContext` type                                 | Auth package, on the `Register` of `@tanstack/react-start`                                                                   | The token is the Convex Auth session's, and Start reads that `Register`                                                                          |
| `expectAuth`                                              | App, in `getRouter`                                                                                                          | The app creates the Convex client                                                                                                                |
| The root `beforeLoad`                                     | Auth package: `sessionBeforeLoad`                                                                                            | The same lines in every app with this session                                                                                                    |
| The provider, plus the release of `expectAuth`            | Auth package: `SessionProvider`                                                                                              | Convex's provider never releases `expectAuth` for a signed-out visitor                                                                           |
| The gate                                                  | Auth package: `redirectWithoutSession` and `RedirectWithoutSession`; the app gives the redirect options                      | Only the server render has the cookie; the browser follows the provider                                                                          |
| The session state in components                           | Auth package: `SignedIn` and `SignedOut`                                                                                     | Convex's provider reports loading during the server render and the hydration                                                                     |
| The cookie session lines in `src/server.ts`               | Convex Auth's own API, written in the app                                                                                    | A helper for HTTP actions belongs upstream                                                                                                       |
| The `/auth/*` routes                                      | Convex Auth's own API (`setupConvexAuthServer`), answered by `src/server.ts`; `convex/http.ts` forwards the three `POST`s    | The handlers are Convex Auth's; the paths are the app's, and the cookies belong to the site's origin                                             |
| The Convex Auth setup files                               | App, with Convex Auth's own API                                                                                              | The providers and the users table are the app's                                                                                                  |
| Deploy and preview commands                               | Hosting package: `convex-hosting deploy`, in the app's scripts and CI                                                        | The upload must run between the build and the push                                                                                               |

## What the packages export

Every export, with who uses it and why it exists. An export with no user in the examples, Bristol,
or ChessMerge goes; the list is checked at every release. At 0.8.0 and 0.5.0 that removed
`serveAsset` and `useSignedIn`.

| Export                                                       | Used by                                                                                                                                            | Why                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hosting `routeAll`                                           | `convex/http.ts` of every app                                                                                                                      | The one entry: one `pathPrefix: "/"` route per method Convex routes, to the action that answers files, then `worker`, which is the Worker script; its absence is the files-only Worker. It returns the action for an app's exact routes past a component prefix |
| hosting `convex.config`                                      | `convex/convex.config.ts` of every app                                                                                                             | Convex's component definition, for `app.use`                                                                                                                                                                                                                    |
| hosting `_generated/component.js` (types)                    | The generated `api.d.ts` of every app                                                                                                              | Convex's codegen imports it for the component's API type                                                                                                                                                                                                        |
| CLI `deploy --build --dist [--dev \| --preview-name]`        | App scripts and CI                                                                                                                                 | The upload must run between the build and the push, with the deployment chosen by the same flags as Convex's CLI                                                                                                                                                |
| CLI `--html-handling`, `--not-found-handling`                | SPA example (`single-page-application`); ChessMerge, server-rendered (`drop-trailing-slash`); Mail, files only (`none`, `single-page-application`) | Cloudflare's own asset settings, stored with the version                                                                                                                                                                                                        |
| CLI `--component`                                            | None today                                                                                                                                         | Convex's own `app.use(hosting, { name })` option; the CLI must match it; Bristol's production used it while hosting 0.3 and 0.4 ran under two names                                                                                                             |
| CLI `upload`                                                 | `deploy` itself, inside `npx convex deploy --cmd`                                                                                                  | The step after the build has to be a program that a shell can call                                                                                                                                                                                              |
| adapter `vite`: `convexSsr()`                                | `vite.config.ts` of server-rendered apps                                                                                                           | The `ssr` environment settings that make Start's server build run in Convex's runtime, the `node:stream` stub included                                                                                                                                          |
| adapter `server`                                             | `src/server.ts` of server-rendered apps                                                                                                            | Start's own stream handler, typed as TanStack's `RequestHandler<Register>`, so `fetch(request, { context })` takes the app's registered context; pages stream as on a Worker                                                                                    |
| adapter `server-build` (types)                               | `convex/http.ts` of server-rendered apps                                                                                                           | The type of the built server module: `{ fetch(request) }`, the shape of the app's `src/server.ts`                                                                                                                                                               |
| auth `vite`: `convexAuth()`                                  | `vite.config.ts` of both SSR examples, next to `convexSsr()` or Cloudflare's plugin                                                                | Resolves the Convex Auth 2.0.0-beta.0 file that holds the SSR provider, which its exports map does not expose, and keeps one copy of Convex Auth in development                                                                                                 |
| auth `.`: `sessionBeforeLoad`                                | The root route                                                                                                                                     | The same `beforeLoad` in every app with cookie sessions                                                                                                                                                                                                         |
| auth `.`: `SessionProvider`                                  | The root component                                                                                                                                 | Convex Auth's provider with the server token, plus the release of `expectAuth` for a signed-out visitor                                                                                                                                                         |
| auth `.`: `redirectWithoutSession`, `RedirectWithoutSession` | The `_authed` layout                                                                                                                               | The server render has the cookie; the browser follows the provider; two moments, two pieces                                                                                                                                                                     |
| auth `.`: `SignedIn`, `SignedOut`                            | Bristol's header and menus                                                                                                                         | Convex's provider reports loading during the server render and the hydration; these wait for the answer                                                                                                                                                         |
| auth `.`: `useSignOutSession`                                | The header's sign-out in the SSR example and Bristol                                                                                               | Convex Auth's `signOut()` resolves when the cookie route failed; this asks the route first, then clears the client, then reloads                                                                                                                                |

## Repository

- `packages/convex-hosting`
  - `src/component`: `schema.ts`, `lib.ts`, `convex.config.ts`, and its generated files.
  - `src/client`: `routeAll`, Cloudflare's handler run against the assets (`answer.ts`), the assets'
    types and lookup (`manifest.ts`), and the shipped declaration of the version module.
  - `src/cli`: the `convex-hosting` command: `deploy`, and `upload`, the inner step that
    `npx convex deploy --cmd` has to call as a program; `manifest.ts` encodes the manifest.
  - `src/workers-sdk`: Cloudflare's asset worker, its tests, and its html_handling and encoding
    cases, copied by `scripts/sync-workers-sdk.ts` from cloudflare/workers-sdk at the commit in
    `UPSTREAM`, each file at its upstream path, so the folder mirrors that repository. Only the sync
    script changes it, and CI fails when the folder differs from what it writes.
  - Whatever `npx convex codegen --component-dir ./src/component` needs to run against an anonymous
    local deployment, and nothing more; `CONTRIBUTING.md` says what that is. No example is involved.
- `packages/convex-hosting-tanstack-start`: the Vite settings and the server entry that make
  TanStack Start's server build run inside a Convex HTTP action (Convex cannot bundle `node:stream`,
  so pages render with React's Web Stream renderer), the types-only `server-build` entry that
  declares the build's server module. It knows nothing about versions.
- `packages/convex-auth-tanstack-start`: the auth package, Convex Auth cookie sessions for TanStack
  Start on any host: the session helpers, the OAuth ambient sign-in that keeps TanStack Router's
  history state, and the `convexAuth()` Vite plugin. It knows nothing about hosting.
- `examples/tanstack-spa`: TanStack Start in SPA mode, served with
  `--not-found-handling single-page-application`.
- `examples/tanstack-ssr`: pages rendered in the `worker` of `routeAll`.
- `examples/tanstack-ssr-workers`: the same app as a Cloudflare Worker, the reference for what is
  Convex-specific.
- `examples/hello-world-assets-only` and `examples/hello-world-assets-only-workers`: Cloudflare's
  static-site template (create-cloudflare `hello-world-assets-only`) on both hosts, `public/`
  byte-identical, no build.
- One `README.md` at the repository root, copied into the package at `prepack`.
- An app has `.convex-hosting/` (ignored, written by the CLI) and nothing else of ours outside
  `convex/convex.config.ts` and `convex/http.ts`.
