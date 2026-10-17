# Proposal: the version id comes from the build

Status: proposal, 2026-10-17, written by an AI assistant for the maintainer's decision. Nothing here
is implemented. A Codex design review of this note is recorded at the end.

## The problem

`convex/http.ts` imports `.convex-hosting/version.js`, the id of the file set that this push serves.
`deploy` mints the id (a random UUID), uploads the files under it, writes the file, and pushes.
Convex bundles `convex/` with esbuild at every push and at `codegen`, and a missing import fails the
bundle. So:

1. On a fresh clone, `npx convex dev` and `npx convex codegen` fail until the first deploy. The
   documented order is `npx convex dev --skip-push`, then `convex-hosting deploy --dev`, then
   `npx convex dev`. The examples commit `convex/_generated` because codegen cannot run before that.
2. Deleting `.convex-hosting/` breaks `npx convex dev` again.
3. The watcher pushes new code with the id of the last deploy from this checkout. After a rebuild
   without a deploy, a new renderer serves the old file set, silently.
4. A production deploy from a development checkout rewrites the file; the watcher then pushes
   production's id to the development deployment, which answers 404 until the next `deploy --dev`.
5. Every earlier fix was tactical and is in the design doc's "Rejected on the way": the `init`
   placeholder and its re-export (0.3, four fixes in one day), the committed version file, the
   app-side script that builds before the first push.

The file exists for one reason: the id is a side effect of a command, so only a file can carry it
into the bundle. No comparable tool works this way. The survey below found none that needs a
generated file before its first command.

## What the binding must guarantee

- G1. The code that serves never serves another deploy's files. A server-rendered page refers to
  hashed asset names and to prerendered pages of its own build.
- G2. The site never switches to a file set that is not fully uploaded.
- G3. Only file sets that no running code names are deleted.

For a files-only site G1 is empty: the serving code is the same for every deploy. Only G2 and G3
apply, and they are about the upload, not about the push.

## How others bind code to its files

The full report, with file paths and line numbers, is
[the prior-art note](./2026-10-17-prior-art-binding-code-to-files.md).

- Cloudflare Wrangler: `wrangler deploy` computes the asset manifest in memory (BLAKE3 per file),
  opens an upload session that returns the missing hashes and a JWT, uploads them, and puts the
  completion JWT into the script upload. One version holds code and manifest; nothing is written
  into the repository. Rollback re-deploys a version with its assets.
- Netlify, Vercel: a deploy is a map of paths to digests; only missing digests are uploaded; the
  deploy goes live when complete, functions included. Content-addressed and atomic.
- SvelteKit's Cloudflare adapter: the build embeds the list of asset paths in the generated server
  bundle, so the server knows its own file set without any file outside the build output.
- get-convex/static-hosting 0.2: no versions. The upload stages rows, then one mutation deletes the
  old rows, inserts the new, and sets a metadata singleton. The deploy command pushes the backend
  first and uploads second, and names the inconsistency window as a goal to minimize.
- Convex CLI: `dev --skip-push` (and the hidden `init`) configure a deployment without bundling;
  `codegen` bundles all of `convex/`; the default runtime has no way to exclude a file or mark an
  import external; there is no pre-push hook; functions read deployment variables with
  `process.env`, which is not atomic with a push.

## Candidates

A. **Keep the generated file.** Known costs 1 to 4. Nothing else changes.

B. **The id is the digest of the file set, so the build carries it.** The version id becomes
`sha256` over the sorted entries (`path`, file `sha256`) plus the config (`html_handling`,
`not_found_handling`, `_headers`, `_redirects`). Anything that has the build can compute it:

- The CLI computes it at upload and uploads under it. A digest the component already holds as
  finished is not uploaded again: `deploy` becomes idempotent and content-addressed, as on Wrangler,
  Netlify, and Vercel.
- A server-rendered app gets it from its build: the adapter's Vite plugin, at the end of the server
  build, computes the same digest over the client output and writes it next to the server bundle,
  `dist/server/version.js`, which `convex/http.ts` imports in place of `.convex-hosting/version.js`.
  That file imports `dist/server/server.js` already, so the precondition stays "build first", the
  Vite norm, and stops being "deploy first".
- A files-only app imports nothing. `routeAll(http, components.hosting)` serves the newest finished
  version: finishing the upload is the switch (G2), and nothing a push does can name the wrong files
  (G1 is empty). This is static-hosting's model where it is correct, and the version-bound model
  where it is needed.
- `.convex-hosting/` goes away: no state in the checkout.

What changes for the four costs: (1) a files-only clone runs `npx convex dev` at once, and the site
answers 404 until the first deploy, as a Worker does before `wrangler deploy`; a server-rendered
clone runs `pnpm run build` first. (2) Deleting `dist/` breaks a server-rendered push, and
`pnpm run build` repairs it; there is no hosting state to delete. (3) A renderer whose build was not
deployed names a digest the component does not have and answers 404 naming it: the mismatch fails
closed instead of serving old files. (4) Files-only: nothing to rewrite. Server-rendered: a
production build in a development checkout makes the watcher push production's digest; 404 naming it
until `deploy --dev`, the same as today, and the deploy is a no-op upload.

Costs: the adapter's plugin depends on the hosting package for the digest function and the
`.assetsignore` rules (today it knows nothing about versions); `route` takes `versionId | null` and
needs "newest finished" as a second lookup; the CLI must refuse a `--dist` whose digest differs from
the one the server build wrote, when both exist.

C. **A pointer the deploy moves**, in the component's table or in a deployment variable
(static-hosting's model for everything). No file, but for a server-rendered app the renderer and the
pointer change in two steps, so for seconds a renderer serves another build's files, which is the
window the version-bound model removed. Right for files-only sites, which B includes.

D. **Cross-version serving of hashed files plus a pointer.** Makes C's window harmless for hashed
assets, not for prerendered pages, and brings back the fallback the design rejected, plus a
retention policy. More machinery than B for a weaker guarantee.

E. **The files travel inside the push** (the spike discussed on 2026-10-17). One atomic push, but
the generated module has the same first-run problem as the version file, and a size ceiling from the
isolate's memory. It does not address this problem.

F. **A package-owned "not deployed yet" state** (the `init` idea). A placeholder that a later build
must replace is what failed in 0.3: the placeholder and the build output drift, and the watcher
cannot tell which one is current. B needs no placeholder because nothing has to exist before the
build, and the build is the app's own command.

## Recommendation

B. The deciding reason: the id becomes a fact of the build instead of a side effect of a command.
Then no command of ours has to run before `npx convex dev`, the thing that breaks on a stale
checkout is `dist/`, which the app's own build repairs, and every mismatch between a renderer and
its files answers 404 with the version's name instead of serving the wrong files.

The SvelteKit adapter is the precedent for the build carrying its file set; Wrangler, Netlify, and
Vercel are the precedents for a content-addressed, idempotent deploy; static-hosting is the
precedent for "newest finished" where the code does not change.

## What B would change, in order

1. Hosting: `readDist` returns the digest; `deploy` uses it as the version id and skips the upload
   of a digest the component holds; `route` accepts `versionId: string | null`, null meaning the
   newest finished version; `markLive` and `collect` treat a files-only version as live when it
   finishes. The tests enumerate the states again.
2. Adapter: `convexSsr()` writes `dist/server/version.js` after the server build, with the digest
   function of the hosting package; the `server-build` types declare it.
3. Apps: a server-rendered `convex/http.ts` imports `../dist/server/version.js`; a files-only one
   imports no version and calls `routeAll(http, components.hosting)`.
4. Examples and docs: the fresh-clone order shortens; `convex/_generated` needs no commit in the
   files-only example; the design doc's model and the README's "How a deploy switches the site" say
   where the id comes from.

Breaking: hosting 0.12.0 and adapter 0.10.0; each app changes one import.

## Questions only the maintainer can answer

- Is "the finished upload is the switch" acceptable for files-only sites, or must a files-only site
  switch together with a backend push? B says the push is not involved.
- Retention of earlier versions for open tabs or rollback is a separate decision; B neither needs
  nor prevents it.

## Codex design review

Pending.
