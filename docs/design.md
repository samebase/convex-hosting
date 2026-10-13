# convex-hosting 0.4: design

A Convex deployment serves the app's site: the files of a build and, when the app renders pages,
those pages. It behaves like Cloudflare Workers with static assets, so a developer who knows that
model learns nothing new: the same files (`_headers`, `_redirects`, `.assetsignore`), the same two
options (`html_handling`, `not_found_handling`), the same responses, computed by Cloudflare's own
asset-serving code. One command deploys. No old version is ever served, and a deploy deletes the
ones before it.

This document is the proposal. Every file, function, option, and table field in the package must
trace to a line here. Nothing exists for compatibility with earlier releases or with
get-convex/static-hosting.

## The model

On Cloudflare, `wrangler deploy` uploads the asset files and the Worker code as one version. The
Worker is bound to the assets it was deployed with, so the switch is atomic, and old versions are
gone from the production hostname. Cloudflare also runs one deployment of a Worker at a time.

On Convex, two systems hold the two halves: `npx convex deploy` pushes the app code, and the site
files live in a component's storage. The design binds them the way Cloudflare does: the pushed code
carries the id of the asset version it was built with, and asks the component for exactly that
version. The push is the switch. There is no pointer that a second step must move, so there is no
moment when new code serves old files.

Deploys do not interleave. A deploy holds a lock in the component from its first call until its
cleanup ends; a second deploy that starts meanwhile is refused with a message that names the first.
Because nothing else can be in flight, the end of a deploy is a safe moment to delete: once the push
has landed, the CLI tells the component, and the component deletes every other version and every
stored file nothing references. Every call of the deploy refreshes the lock, and during the push,
when the CLI makes no other call, it refreshes the lock every 30 seconds. The lock expires 2 minutes
after the last refresh, so a dead deploy frees itself in 2 minutes with nobody involved, while a
live one, however slow its upload or push, keeps it. Every call of a deploy first checks that the
lock is still its own: when it expired and another deploy took it, the call fails with "lost its
lock", the deploy fails, and nothing is deleted; when that answer comes from a heartbeat during the
push, the CLI kills the push. There is no cancel command: waiting 2 minutes is the cancel.

## Deploy

```
convex-hosting deploy --build "<command>" --dist <dir> [--html-handling ...] [--not-found-handling ...] [--preview-name <name>]
```

Every Convex call of one deploy reaches one deployment, and the CLI parses no credential to get
there: it passes the same explicit selector to `npx convex deploy` and to every `npx convex run`,
`--preview-name <name>` when given, else `--prod`, because `npx convex deploy` goes to production by
default while `npx convex run` goes to development. A deploy key in the environment
(`CONVEX_DEPLOY_KEY` or its alias `CONVEX_DEPLOYMENT_TOKEN`) wins over that selector in both
commands, the same way. A self-hosted deployment (`CONVEX_SELF_HOSTED_URL`) takes no selector.

1. The CLI chooses a random version id. It writes nothing yet: the version file is written only
   after the lock is taken, so a second deploy from the same checkout, refused at the lock, cannot
   overwrite the id that the first one pushes. A typecheck of `convex/` before the file exists
   passes through the committed declaration.
2. It runs
   `npx convex deploy --cmd "<command> && convex-hosting upload --dist <dir> --version-id <id> ..."`.
   Both run in the project directory; a build must not change directory. Convex gives the build the
   deployment's URL in `CONVEX_URL` and in one framework variable such as `VITE_CONVEX_URL`, as it
   documents for frontends. Inside the command, `upload`:
   1. collects the files of `<dir>`, honoring `.assetsignore`, and computes each file's sha256 and
      content type; reads `_headers` and `_redirects` with Cloudflare's parsers into the version's
      config;
   2. stores the config as one file through an upload URL, because `npx convex run` passes arguments
      on the command line, which the operating system limits, and a `_redirects` file can be large;
      (`npx convex run` stays the transport because it handles every way a deployment is selected:
      login, deploy keys, previews by name;) then calls `createVersion` with the config's storage
      id. The component takes the lock, or refuses when another version holds it and has refreshed
      it less than 2 minutes ago, and creates the version in state `uploading`;
   3. asks `knownFiles` which of its hashes already have a stored file, from any version's entries,
      in batches that fit a command line;
   4. uploads the other files a few at a time, then sends every entry complete, with its storage id
      (the known ones from step 3, the new ones from the upload), in batches to `recordFiles`, which
      checks each stored file's sha256 against Convex's storage metadata and inserts the entries; an
      entry is never without a file;
   5. calls `finishVersion`, which puts the version in state `ready`. The CLI calls it only after
      every batch succeeded; a crashed upload leaves an `uploading` version, which the next deploy
      deletes, and a retry reuses every file the crashed run stored, through step 3;
   6. writes `.convex-hosting/version.js` with the id, in the CLI's state folder at the project
      root, like Wrangler's `.wrangler/`; the folder carries its own `.gitignore`, so nothing of it
      reaches git and no tool writes into `convex/`. The file is a build artifact that `http.ts`
      imports, as a server-rendered app's `http.ts` already imports its server build; one committed
      declaration line in `convex/` gives TypeScript its shape on a fresh clone. Then, still inside
      `npx convex deploy`, Convex bundles `convex/` with the new id and pushes. The push is the
      switch. From `startVersion` to the end of the deploy, the CLI calls `heartbeat` every 30
      seconds, through the upload and the push, so the lock means that the process is alive.
3. When `npx convex deploy` returns success, the CLI calls `finishDeploy`. The component deletes
   every other version, its entries, and the stored files no remaining entry uses, then every file
   in `_storage` that no entry references (this deploy's config file included), in batches that
   schedule themselves, and releases the lock when done. When `npx convex deploy` fails, the CLI
   calls `releaseLock`; the version stays, so the retry reuses its files, and the retry's cleanup
   deletes it.

**First install.** The component's functions exist only after a push, and a new preview deployment
exists only once `npx convex deploy` has created it, which happens before it runs the command. So
the inner `upload` decides. Its first call is a probe,
`npx convex run --component <name> --inline-query`, because that path of the Convex CLI looks the
component up before it runs anything and prints the exact message
`Component path "<name>" was not found.` when the deployment does not have it (a function run
against a missing component answers only a generic server error, which must not count). On that
exact message, `upload` writes the version file and a marker file in `.convex-hosting/` and exits
without uploading, so the push that follows installs the component. `deploy` sees the marker after
`npx convex deploy` returns and runs the upload then, followed by `finishDeploy`. Until that upload
ends, the site answers 404 (see Serve). This happens once per deployment. It is not protected by the
lock, because the component does not exist yet: run the first deploy of a deployment once, alone.

**Development deployment.** `convex-hosting dev --build "<command>" --dist <dir>` does for the
development deployment what `deploy` does for production, with the same code and one difference: the
push is `npx convex dev --once`. It runs the build in the project directory (Vite reads the
deployment's URL from `.env.local`, so no nesting is needed), uploads, writes the version file,
pushes, and calls `finishDeploy`. First install: when the probe says the component is missing, it
writes the version file, pushes, uploads, and then calls `finishDeploy`. The lock and the heartbeat
apply as in `deploy`. No selector is passed to any Convex command: the development deployment is the
one `npx convex dev` and `npx convex run` pick by default. A fresh clone runs `convex-hosting dev`
once; after that `npx convex dev` watches as usual, and the version file is one more input it pushes
when a later `dev` run rewrites it. `upload` is not a command for people: it is the inner step that
`deploy` runs inside `npx convex deploy --cmd`.

Two things in the development loop are transient and documented, not solved: when a server-rendered
app's build changes `dist/server`, which `http.ts` imports, a running `npx convex dev` pushes before
`convex-hosting dev` has written the new id, so pages reference files that answer 404 until that run
ends; and a production deploy run from the same checkout writes production's id, which a running
`npx convex dev` then pushes to the development deployment, where that version does not exist, until
the next `convex-hosting dev`. Production deploys belong in CI or a separate checkout.

**Two deploys at once.** The second is refused at `startVersion` with the first's version id and the
seconds since it last refreshed the lock. Its build has run for nothing; the user retries.

**Failures.** A deploy that dies holding the lock blocks the next deploy until 2 minutes after its
last refresh; the next deploy's cleanup deletes its version. A deploy whose push landed but whose
`finishDeploy` never ran leaves the old versions until the next deploy; its own version is the one
the code names, and the next deploy deletes it only after its own push. A push that the command
reports as failed may still have landed; the site then serves the new version, the lock is released
as for a failure, and the next deploy is a normal one. A deploy whose process stops for more than 2
minutes, for example on a laptop that sleeps, loses its lock; when it wakes up, its next heartbeat
answers "lost its lock" and the CLI kills its push at once, so the push lands only in the seconds
between the wake-up and that heartbeat. If it does land, the site answers 404 naming the missing
version, and a redeploy fixes it. No resume logic.

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
// A static site: 404. A server-rendered site: render the page, with `Cache-Control: no-store`,
// because the deployment's Cloudflare front caches answers on static-looking paths.
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
that body and returns the response. When the query finds no storage URL for the entry, or storage
answers 404, because a cleanup deleted the file, the answer is 404 with `Cache-Control: no-store`;
any other fetch failure answers 502 with no caching. An app cannot read a component's storage, so
each asset hit costs that one fetch.

When the version does not exist or is still `uploading`, `serveAsset` returns a 404 response that
names the version, with `Cache-Control: no-store`, so a half-installed site answers 404 rather than
rendering pages without their files, and the deployment's Cloudflare front, which caches 404 answers
on static paths, does not keep that answer after the upload ends. `null` means one thing: no asset
matched, and the app continues. `serveAsset` makes no mutation call.

The two callbacks that Cloudflare's code takes map to the version's entries: `exists(path)` reads
one index entry and returns its ETag, the sha256 followed by a short hash of the content type, so
that identical bytes stored under two content types stay distinct; `getByETag` returns the content
type of the entry that `exists` found and a placeholder stream, which `serveAsset` replaces with the
body. Nothing is added to Cloudflare's headers. Long caching of hashed files is a `_headers` rule,
as on Cloudflare.

Other HTTP routes of the app (auth, APIs) win over the site route when they are exact paths or
longer prefixes, by Convex's router rules for the same method.

## Component

Three tables.

| Table      | Fields                                                                                                        | Indexes                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `versions` | `versionId`, `state` (`uploading`, `ready`), `config` (JSON string)                                           | `by_versionId`                                 |
| `entries`  | `versionId`, `path`, `sha256` (hex), `contentType` (absent when the file name has no known type), `storageId` | `by_version_path`, `by_sha256`, `by_storageId` |
| `deploy`   | one row at most: `versionId`, `lastCallAt`                                                                    |                                                |

Creation times come from `_creationTime`. `config` is the JSON of Cloudflare's `AssetConfig` for the
version: `html_handling`, `not_found_handling`, `headers`, `redirects`. It is a string because
`redirects.staticRules` has one field per rule and Convex limits an object to 1,024 fields. A
document is limited to 1 MiB, so the CLI refuses a config above 900 KiB, leaving room for the other
fields and the encoding, and names the file that causes it; Cloudflare's own rule limits (100 header
rules, 2,000 static and 100 dynamic redirects) fit unless paths are very long.

Functions. The CLI calls the internal ones with `npx convex run --component`; `serveAsset` calls the
public one through the component reference (an app can call only a component's public functions, and
clients cannot call them at all). Every internal call of a deploy checks that the lock is its own
and refreshes `lastCallAt`, or fails; `heartbeat` exists to do only that.

| Function             | Kind              | Does                                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateUploadUrls` | internal mutation | Returns `count` upload URLs.                                                                                                                                                                                                                                                            |
| `createVersion`      | internal action   | Takes the lock or refuses. Reads the config from storage and creates the version in state `uploading`. Idempotent for the same id and config.                                                                                                                                           |
| `knownFiles`         | internal query    | For a list of hashes, the stored file ids that entries of any version already have.                                                                                                                                                                                                     |
| `recordFiles`        | internal mutation | Inserts complete entries after checking each stored file's sha256; an entry that exists with the same hash is skipped.                                                                                                                                                                  |
| `finishVersion`      | internal mutation | Marks the version `ready`.                                                                                                                                                                                                                                                              |
| `heartbeat`          | internal mutation | Refreshes the lock's timestamp. The CLI calls it every 30 seconds from `startVersion` to the end of the deploy.                                                                                                                                                                         |
| `finishDeploy`       | internal mutation | Only while this version holds the lock. Deletes every other version, their entries, and the stored files no remaining entry uses, then `_storage` files no entry references; one batch per call, scheduling itself with `runAfter(0)` while work remains; releases the lock at the end. |
| `releaseLock`        | internal mutation | Releases the lock when the push failed; the version stays.                                                                                                                                                                                                                              |
| `route`              | public query      | Runs Cloudflare's `canFetch` and `handleRequest` for one request against one version; reports the version's state.                                                                                                                                                                      |

The package sets one limit of its own: 25 MiB per file, Cloudflare's limit per asset, because the
HTTP action that serves a file cannot answer more than Convex's 100 MiB response limit anyway.
Convex's limits apply: 1 MiB per document, and the transaction limits (16,000 writes, 32,000
documents scanned, 16 MiB read and written, 8,192 array elements, 4,096 index ranges, argument and
result sizes) shape the batches.

## Not here, and why

- No live pointer, no `activate`, no `getLiveVersion`: the pushed code names its version.
- No cron, no retention: a deploy deletes the versions before it, under a lock that keeps another
  deploy from being in flight.
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
  - `src/cli`: the `convex-hosting` command: `dev` and `deploy`, and `upload`, the inner step of
    `deploy`.
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
- An app has `.convex-hosting/` (ignored, written by the CLI) and one declaration line in `convex/`.
