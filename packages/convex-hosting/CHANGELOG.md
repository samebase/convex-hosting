# Changelog

## 0.13.0

- The package defines `queueMicrotask` when the runtime has none. Convex's runtime lacks it, and a
  handler written for Cloudflare Workers may call it (TanStack's router does on every rendered
  page). The definition runs when `convex/http.ts` imports this package, so import it before the
  app's server entry. It moved here from the TanStack Start adapter 0.9.3, because the gap is
  Convex's, not the framework's.

## 0.12.0

- `deploy --dev` refuses a deploy key in the environment, and `deploy --preview-name` accepts only a
  preview key: a deploy key wins over every selector in the Convex CLI, so a production key would
  have sent either to production, with a frontend built for development.
- A link to a folder in `--dist` is not walked, as Wrangler does not walk it; a link to a file still
  counts as the file it points to.
- When the push landed but the site URL could not be read, the error says the version was deployed.
- A failed upload names the file and says the deploy can be run again.
- The package ships the Cloudflare notice and licenses it owes (`NOTICE`, `LICENSE-MIT`,
  `LICENSE-APACHE`) and declares Node 22 or later, which its `parseEnv` call needs.

## 0.11.0

- `deploy` no longer requires `--build`: a site with no build, such as a folder of files, deploys
  with `convex-hosting deploy --dist <dir>`, and the upload is the whole `--cmd` of
  `npx convex deploy`.

## 0.10.0

- `routeAll(http, component, versionId, worker?)` replaces `serveSite`. It builds the site's HTTP
  action with Convex's `httpActionGeneric` and routes it for every method Convex routes, at every
  path, so `convex/http.ts` reads `routeAll(http, components.hosting, versionId, server)`: no method
  loop and no `httpAction`. It returns the action for the exact routes an app registers past a
  component's HTTP prefix, such as cookie-session routes under Convex Auth's `/auth`. Breaking:
  `serveSite` is gone.

## 0.9.0

- `serveSite(component, versionId, worker?)` returns the handler of the site routes, so
  `convex/http.ts` reads `httpAction(serveSite(components.hosting, versionId, server))`. The third
  argument is the Worker script itself, the object with `fetch(request)` that the app's server entry
  exports, in place of a `render` callback that closed over the request. Breaking: the old
  `serveSite(ctx, component, request, versionId, render?)` is gone.
- `convex/http.ts` registers the handler for every method, as every request reaches a Cloudflare
  Worker: a file answers 405 to any method but GET and HEAD, a miss goes to the Worker or answers
  404 without one. The README and the examples show the loop; the package code is unchanged.

## 0.8.0

- `serveSite` without `render` routes like a Cloudflare Worker without a script:
  `not_found_handling` applies to every request, not only to navigations. `curl`, uptime monitors,
  and link-preview bots now get the single-page fallback or the 404 page where they got a bare 404,
  and a missing hashed file on a single-page app gets the shell with 200. `serveSite` with `render`
  keeps the routing of a Worker with a script. The component query `route` takes `hasUserWorker`,
  which `serveSite` sets from the presence of `render`; the app sets nothing.
- Every 404 that the handler answers, including the custom 404 page, has `Cache-Control: no-store`.
- `deploy` prints the site URL when it ends, which it asks the deployment for (`CONVEX_SITE_URL`
  through an inline query), and appends `url=<site URL>` to `$GITHUB_OUTPUT` when that is set. A
  workflow reads it as `steps.<id>.outputs.url` and no longer needs to record it in the build
  command.
- `serveAsset` is removed, and `serveSite` is the one entry. `render` is the code that runs on a
  miss, with the request in its closure, so an app that called `serveAsset` and answered misses
  itself passes that code as `render`.

## 0.7.0

- `convex-hosting init` is gone, with the placeholder `.convex-hosting/server.js` it wrote. On a
  fresh clone, `npx convex dev --skip-push` creates the development deployment and writes
  `.env.local` without a push; `convex-hosting deploy --dev` then builds, uploads, writes
  `.convex-hosting/version.js`, and pushes; after that, `npx convex dev` works as usual. Remove
  `init` from the app's scripts, such as `predev`.
- A server-rendered app's `convex/http.ts` imports its server build directly, such as
  `../dist/server/server.js`. The package no longer declares a server module: the framework adapter
  declares the type of its build (`@samebase/convex-hosting-tanstack-start/server-build` 0.4.0). The
  package declares only `.convex-hosting/version.js`.
- An older upload never goes live over a newer one: `markLive` marks a version only when no live
  version was created after it. Before, a request that started on replaced code and reached its
  lookup after the new code's first request could make its old version live, and the new version's
  files were deleted. `markLive` takes only `versionId`, and `route` no longer returns
  `newestLiveAt`; `serveSite` and `serveAsset` are unchanged. Deploys to one deployment must not
  overlap.
- A symbolic link in `--dist` to another folder of the build no longer hides that folder when it
  comes first in the listing: both paths are uploaded. Only a link to a folder that contains it,
  such as a link to `--dist` itself, is skipped.

## 0.6.0

- `convex-hosting init` also writes `.convex-hosting/server.js`, a placeholder server entry that
  answers 503 with `no-store`, and keeps an existing one. A server-rendered app imports this file in
  `convex/http.ts`, so `npx convex dev` bundles on a fresh clone before the first build. The
  framework adapter's Vite plugin replaces it with a re-export of the server build.
- The package declares the type of `.convex-hosting/server.js`, as it does for `version.js`.
- With the server entry at a fixed path, `convex/http.ts` is the same for every framework; the
  adapter's build step points the file at the framework's own output.

## 0.5.0

- `serveSite(ctx, component, request, versionId, render?)` serves the whole site from one route: the
  file that matches, else the page that `render` returns, else 404. A page and a 404 answer
  `Cache-Control: no-store`, so `convex/http.ts` no longer sets it. `serveAsset` stays, as its first
  step.

## 0.4.1

- `convex-hosting init` writes `.convex-hosting/version.js` with no site version when it is absent,
  so `npx convex dev` can bundle `convex/http.ts` on a fresh clone. Run it before `npx convex dev`,
  for example as a `predev` script.
- The README has numbered setup steps, rules, and a section on deploy tools and CI: tools that run
  `convex deploy` themselves, the permissions of a scoped deploy key, and where release checks go.
  It also says how to test a deep link as a browser opens it.

## 0.4.0

A new install. 0.4 does not read the data of 0.3.x and has no migration: delete the tables of the
old component by hand, then set up the app as the README says.

- One command, `convex-hosting deploy`, for production, a preview (`--preview-name <name>`), and the
  development deployment (`--dev`). The push switches the site.
- Cloudflare's asset handler serves the files, with `_headers`, `_redirects`, `.assetsignore`,
  `html_handling`, and `not_found_handling`.
- The first request that new code serves marks its version live and deletes the versions live before
  it. A version that never becomes live is deleted when it is a day old.

Earlier versions: see the [release history](https://github.com/samebase/convex-hosting/releases).
