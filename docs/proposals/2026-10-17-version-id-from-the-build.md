# Proposal: the build owns the version file

Status: proposal, 2026-10-17, written by an AI assistant for the maintainer's decision. Nothing here
is implemented. Two Codex design reviews are recorded at the end; the second version of this note is
the one that survived the first.

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

## Why the file cannot simply go

The push must be the switch: a single-page app whose new frontend calls a new backend function must
not go public before the push that carries the function, and a server-rendered page must serve the
hashed files of its own build. So the pushed code has to name its file set, and Convex gives code
exactly one way to carry a value into the bundle: a file that `convex/http.ts` imports. There is no
pre-push hook, no bundle-time variable, and no external import in the default runtime (see
[the prior-art note](./2026-10-17-prior-art-binding-code-to-files.md), Convex CLI section). A
deployment variable read with `process.env` at request time is a pointer that a command moves, not
atomic with the push, which the design rejected for server-rendered sites.

What can change is who writes the file and what it names. Today the deploy writes it, so the file is
a side effect of a command that must have run. If the build writes it, the file is build output,
like `dist/`, and the thing that must have run is the app's own build.

## What the binding must guarantee

- G1. The code that serves never serves another build's files.
- G2. The site never switches to a file set that is not fully uploaded.
- G3. A file set is deleted only after another has served in its place. A request that was already
  running on replaced code when the switch happened may answer 404 naming its version; the design
  states this today and the client handles the file-level case.

## How others bind code to its files

The [prior-art note](./2026-10-17-prior-art-binding-code-to-files.md) has the sources. None of
Wrangler, Netlify, Vercel, the SvelteKit and Astro adapters, OpenNext, or static-hosting needs a
generated file in the repository before its first command. Wrangler keeps the manifest in memory and
binds it to the script upload with a completion token; Netlify and Vercel upload by digest and go
live when complete; the SvelteKit adapter embeds the asset list in the server bundle it builds;
static-hosting swaps the whole file set in one transaction and pushes first, upload second. The
precedent that applies here is the SvelteKit adapter's: the build knows its own file set.

## The proposal

**The build mints an opaque build id and writes `.convex-hosting/version.js` first, before any
bundle; the deploy uploads the build's files under that id; the push names it.**

- A Vite plugin from the hosting package, `convexHosting()`, mints a random id when the build starts
  and writes the file before Vite writes a single output file. The adapter's `convexSsr()` includes
  it, so a server-rendered app adds nothing. A single-page app adds the plugin to its
  `vite.config.ts`.
- `convex-hosting deploy --dist <dir>` reads the id from the file, creates a publication for it,
  uploads the files that the component does not hold yet (deduplicated by file hash, as today), and
  pushes. A second deploy of the same build, to the same deployment or another, uploads nothing new
  and creates a new publication; the push names the build, and the component serves the newest
  publication of that build.
- A site with no build, such as the static-site example, has no file and no id:
  `routeAll(http, components.hosting)` serves the newest finished publication, and the finished
  upload is the switch. This is the one case where the push is not the switch, and it is the case
  where there is no built frontend to couple to the push. The README states it.

What this does to the four costs:

1. A fresh clone runs the app's build, then `npx convex dev`. `pnpm run build` needs the deployment
   URL, so the order is `npx convex dev --skip-push`, `pnpm run build`, `npx convex dev`, and the
   site answers 404 naming the build until `deploy --dev`. No hosting command precedes the first
   push; a site with no build runs `npx convex dev` at once.
2. Deleting `.convex-hosting/` or `dist/` breaks the push until the next build, the app's own
   command. There is no hosting state in the checkout, only build output.
3. The id on disk is always the id of the build on disk, written before the bundles: a watcher push
   during or after a rebuild names a build the component does not hold and answers 404 naming it,
   until `deploy --dev`. The mismatch fails closed instead of serving old files.
4. A production build in a development checkout makes the watcher push production's build id to
   development, which answers 404 naming it until `deploy --dev`, whose upload reuses every file by
   hash. Production deploys belong in CI or a separate checkout, as the docs say today; this
   proposal does not change that, it only makes the failure name its cause.

## What the first review found, and how this version answers it

- A digest is file identity, not publication order; reusing one breaks `markLive` and deletion.
  Answered: the id is opaque and per build, and a publication is a row per deploy with its own
  creation time. The component keys file sets by build id and publications by creation order.
- Two files written by the build can be bundled in a wrong pair. Answered: the id is written first,
  so a push that catches the build mid-way names a build with no files, which fails closed.
- Finishing the upload cannot be the switch for a single-page app that depends on new backend
  functions. Answered: every built site keeps the push as the switch. Only a site with no build
  switches at the finished upload, stated as such.
- A digest computed at the end of the server build misses prerendered pages. Answered: there is no
  digest; the id is minted at the start and the deploy reads the finished `--dist`.
- The serving configuration has no single owner. Answered: the id names files only; `html_handling`,
  `not_found_handling`, `_headers`, and `_redirects` belong to the publication, as today.
- The first-install marker lives in `.convex-hosting/`. Answered: after the push, `deploy` checks
  that the build's publication is finished on the target and uploads if it is not; no marker.
- The shared-checkout hazard remains. Answered: stated as a documented limit, with a 404 that names
  the build instead of a silent mismatch.

## Candidates considered

- Keep the deploy-written file: costs 1 to 4 stay.
- A pointer the deploy moves, in a table or a deployment variable: no file, but a server-rendered
  renderer and its files change in two steps, which is the window the design removed.
- The digest of the file set as the id: the first version of this note; rejected by the review for
  the reasons above.
- Cross-version serving of hashed files: brings back the fallback the design rejected, for a weaker
  guarantee.
- The files inside the push: a size ceiling from the isolate's memory, and the same generated module
  before the first push.
- A package-owned placeholder (`init`): the 0.3 failure; a placeholder and the build output drift.

## What would change, in order

1. Hosting: the `convexHosting()` Vite plugin (mint the id at build start, write the file first);
   the schema splits publications from file sets; `route` takes `buildId: string | null`, null
   meaning the newest finished publication; `deploy` reads the id from the file, creates the
   publication, uploads the missing files, pushes, and verifies the publication on the target.
2. Adapter: `convexSsr()` includes the hosting plugin.
3. Apps: a single-page app adds `convexHosting()` to `vite.config.ts`; a site with no build drops
   the version import and calls `routeAll(http, components.hosting)`; the server-rendered app
   changes nothing in `convex/http.ts`.
4. Examples and docs: the fresh-clone order, the README's "How a deploy switches the site", the
   design doc's model.

Breaking: hosting 0.12.0 and adapter 0.10.0.

## Questions only the maintainer can answer

- Is "the finished upload is the switch" acceptable for a site with no build?
- Is a production deploy from a development checkout a supported case, or a documented limit?
- Must a clean server-rendered checkout run `npx convex dev` before any build? Under this proposal
  it runs after the build, as a Cloudflare checkout runs `wrangler deploy` after its build.

## Codex design reviews

First version (the digest as the id): not approved. Four blocking concerns (digest versus
publication order, two files paired wrongly, upload-as-switch for coupled single-page apps, digest
before prerendering) and four important ones (configuration owner, first-install marker,
shared-checkout hazard, prior art overstated). This version answers each above.

Second version (this note): pending.
