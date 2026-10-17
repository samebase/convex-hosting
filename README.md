# Convex Hosting

Host a web app on Convex, next to its backend: the files of a build and, when the app renders pages,
those pages. The site is at `https://<deployment>.convex.site`.

It works like
[Cloudflare Workers with static assets](https://developers.cloudflare.com/workers/static-assets/):
the same `_headers`, `_redirects`, and `.assetsignore` files, the same `html_handling` and
`not_found_handling` options, and the same responses, computed by Cloudflare's own asset-serving
code, checked against Cloudflare's own test cases for `html_handling` and path encoding, and against
its integration tests for a files-only site, run on a local deployment.

## Setup

Requires `convex` 1.46 or later.

1. Install:

   ```sh
   npm install @samebase/convex-hosting
   ```

2. `convex/convex.config.ts` mounts the component:

   ```ts
   import { defineApp } from "convex/server";
   import hosting from "@samebase/convex-hosting/convex.config";

   const app = defineApp();
   app.use(hosting);

   export default app;
   ```

3. `convex/http.ts` sends every method to `serveSite`, as every request reaches a Cloudflare Worker:
   a file answers GET, another method on a file answers 405, and Convex answers `HEAD` through the
   GET handler.

   ```ts
   import { httpRouter } from "convex/server";
   import { serveSite } from "@samebase/convex-hosting";
   import { components } from "./_generated/api.js";
   import { httpAction } from "./_generated/server.js";
   import { versionId } from "../.convex-hosting/version.js";

   const http = httpRouter();

   const site = httpAction(serveSite(components.hosting, versionId));
   for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
     http.route({ pathPrefix: "/", method, handler: site });
   }

   export default http;
   ```

4. Deploy once before the first `npx convex dev` push. `convex/http.ts` imports
   `.convex-hosting/version.js`, which only a deploy writes, and the deploy's build needs the
   deployment's URL, which only `npx convex dev` writes to `.env.local`. So on a fresh clone:

   ```sh
   npx convex dev --skip-push   # creates your dev deployment and .env.local, no push
   npx convex-hosting deploy --dev --build "vite build" --dist dist --not-found-handling single-page-application
   npx convex dev               # then work as usual
   ```

   The `deploy --dev` line builds, uploads, writes `.convex-hosting/version.js`, and pushes. If
   `.convex-hosting/` is deleted later, `npx convex dev` fails with
   `Could not resolve "../.convex-hosting/version.js"`, and `deploy --dev` fixes it.

5. Deploy production, from CI or a terminal:

   ```sh
   npx convex-hosting deploy --build "vite build" --dist dist --not-found-handling single-page-application
   ```

An app set up this way: the
[SPA example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-spa), live at
[quick-fish-630.convex.site](https://quick-fish-630.convex.site).

`convex-hosting` keeps its state in `.convex-hosting/` at the project root, next to `convex/`, like
Wrangler's `.wrangler/`. The folder has its own `.gitignore`, so git ignores it. The package
declares the type of `.convex-hosting/version.js`, so the app typechecks without it. A
server-rendered app gets the type of its server build from the framework adapter.

## Rules

- Deploy production and previews with `convex-hosting deploy`, never with a plain
  `npx convex deploy`. A plain push sends whatever version `.convex-hosting/version.js` names, the
  version of this checkout's last deploy, which is often another deployment's: the site answers 404
  until the next `convex-hosting deploy`.
- Do not commit `.convex-hosting/`. It ignores itself.
- Do not change directory in `--build`. The build and the upload run in the project directory.

## Deploy

`deploy` runs `npx convex deploy` with your build and the upload of `--dist` as its `--cmd`. The
pushed code names the version it was built with, so the push switches the site. Then the command
prints the site URL, which it asks the deployment for (`CONVEX_SITE_URL`), and ends. The first
request that the new code serves marks its version live, which deletes the versions that were live
before it. A version that never becomes live, from a deploy that failed, is deleted when it is a day
old, with the stored files that no version uses. Nothing is deleted while a site gets no request.

`deploy` goes to production. `--preview-name <name>` sends it to that preview (with a login or a
project's preview deploy key; always pass the name with that key), and `--dev` to the development
deployment (see [Development](#development)). A deploy key in `CONVEX_DEPLOY_KEY` or
`CONVEX_DEPLOYMENT_TOKEN` (from the environment or `.env.local`) selects its own deployment instead,
and so does `CONVEX_SELF_HOSTED_URL` for a self-hosted deployment.

The first deploy to a deployment pushes the component, then uploads the files. Until that upload
ends, the site answers 404.

Run one deploy at a time per deployment; the examples'
[deploy workflow](https://github.com/samebase/convex-hosting/blob/main/.github/workflows/deploy-examples.yml)
queues them, with one `concurrency` group per deployment.

## Deploy tools and CI

- **The deploy keys** go into repository secrets. Create the production key with the Convex CLI and
  hand it to `gh secret set` on standard input, which keeps it off the screen and out of process
  arguments:

  ```sh
  key=$(npx convex deployment token create "<repository> deploy.yml" --prod) && printf '%s' "$key" | gh secret set CONVEX_DEPLOY_KEY
  ```

  The CLI cannot create a project's preview deploy key, so use the management API, with a personal
  or team access token from the Convex dashboard in `CONVEX_TOKEN`:

  ```sh
  key=$(curl -s -X POST "https://api.convex.dev/v1/projects/<project id>/create_preview_deploy_key" \
    -H "Authorization: Bearer $CONVEX_TOKEN" -H "Content-Type: application/json" \
    -d '{"name": "<repository> preview.yml"}' | jq -er .previewDeployKey) && printf '%s' "$key" | gh secret set CONVEX_PREVIEW_DEPLOY_KEY
  ```

  A failed first command stops before anything is stored.

- **A tool that runs `convex deploy` itself**, such as Alchemy's `Convex.Code`, has no place for the
  upload, which must happen between the build and the push. Run `convex-hosting deploy` in place of
  that tool's push step, with the deploy key in `CONVEX_DEPLOY_KEY`.
- **A deploy key limited to some actions** needs `deployment:deploy`,
  `deployment:functions:runInternalQueries`, `deployment:functions:runInternalMutations`,
  `deployment:functions:runInternalActions` (the upload calls one internal action), and
  `deployment:functions:runTestQuery` (the first-install check and the site URL are inline queries).
- **Checks that must stop a release** run before `convex-hosting deploy`, because its push switches
  the site. Checks that need the new functions run after it.
- **A re-run of an old workflow run** checks out its old commit, and its push puts older code over
  newer code; a `concurrency` group orders runs but does not refuse a stale one. So the examples'
  workflows check, right before the deploy, that the commit is still the head of `main`, or of the
  pull request for a preview, and fail otherwise.
- **A step that needs the site URL**, such as a preview comment, reads it from the deploy step: when
  `GITHUB_OUTPUT` is set, `deploy` appends `url=<site URL>` to it, so give the deploy step an `id`
  and read `steps.<id>.outputs.url`.

## Your own domain

A custom domain needs the Convex Pro plan. Add it to the deployment in the dashboard, under
Deployment Settings, Custom Domains, with "HTTP Actions" as the destination, or with the management
API: `POST https://api.convex.dev/v1/deployments/<deployment>/create_custom_domain` with
`{"domain": "<domain>", "requestDestination": "convexSite"}`.

Then create the two records that the dashboard shows: a `CNAME` from the domain to `convex.domains`,
and a `TXT` record at `_convex_domains.<domain>` whose value is the deployment's name. On
Cloudflare, make the `CNAME` DNS only; Convex documents a proxied record as an
[advanced setup](https://docs.convex.dev/production/abuse-protection). Verification can take up to
30 minutes.

Do not choose the domain under "Override Environment Variables". That changes `CONVEX_SITE_URL`
everywhere in the app, and Convex Auth uses it as the token issuer and in its redirect URLs.

An apex domain, such as `example.com`, relies on Cloudflare's CNAME flattening and is not tested
yet.

## Development

The inner loop is your framework's dev server, such as Vite's, which serves the frontend locally
with hot reload against the development deployment's URL from `.env.local`, plus `npx convex dev`,
which pushes your function changes. Neither needs a deploy.

When the development deployment should serve the current build, run the one-shot command:

```sh
npx convex-hosting deploy --dev --build "vite build" --dist dist --not-found-handling single-page-application
```

`deploy --dev` goes to the development deployment of this checkout, the one in `.env.local`. It runs
the build itself, uploads `--dist`, writes `.convex-hosting/version.js`, and pushes with
`npx convex run --push`, which works whether or not `npx convex dev` runs. The build runs with your
environment, so the framework reads the deployment's URL from `.env.local` (Vite reads
`VITE_CONVEX_URL`). Against an anonymous local deployment, `deploy --dev` needs `npx convex dev`
running, because without it every Convex CLI call starts and stops its own backend and the upload's
requests find nothing; cloud development deployments do not have this constraint. There is no watch
mode: a build, an upload, and a push per change is not an inner loop, and Cloudflare's own tooling
works the same way, with a local dev server and a push on demand.

Two cases are transient:

- A server-rendered app imports its server build in `convex/http.ts`, so a running `npx convex dev`
  pushes after the build, before `deploy --dev` writes the new version. Until `deploy --dev` ends,
  the new pages refer to files that answer 404.
- A production deploy writes production's version to the version file, and a running
  `npx convex dev` pushes it to the development deployment, where that version does not exist, until
  the next `deploy --dev`. Run production deploys in CI or in a separate checkout.

## Options

| Option                         | Values                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `--dev`                        | The development deployment of this checkout, instead of production                     |
| `--preview-name <name>`        | The preview deployment with this name, instead of production                           |
| `--html-handling <value>`      | `auto-trailing-slash` (default), `force-trailing-slash`, `drop-trailing-slash`, `none` |
| `--not-found-handling <value>` | `none` (default), `single-page-application`, `404-page`                                |
| `--component <name>`           | The component instance, `hosting` by default                                           |

The two handling options work as
[Cloudflare documents them](https://developers.cloudflare.com/workers/static-assets/routing/).

Each file of `--dist` must be 25 MiB or smaller, and the CLI names a file that is larger. This is
Cloudflare's limit per asset, and the HTTP action that serves a file cannot answer more than
Convex's 100 MiB response limit anyway.

## `_headers`, `_redirects`, and `.assetsignore`

Put them at the root of `--dist`, as for Cloudflare:
[`_headers`](https://developers.cloudflare.com/workers/static-assets/headers/),
[`_redirects`](https://developers.cloudflare.com/workers/static-assets/redirects/), and
[`.assetsignore`](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets).
For a Vite app, put them in `public/`, which Vite copies into `dist/`. They are not served. Symbolic
links in `--dist` are followed, as Wrangler follows them, also when they point outside the folder; a
link to nothing, or to a folder that contains it, is skipped with a message, and a link to another
folder in `--dist` uploads its files under both paths. `.assetsignore` excludes what a link should
not publish.

Every asset has `Cache-Control: public, max-age=0, must-revalidate` and an `ETag`. To cache hashed
files for a year, add a `_headers` rule:

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

## Routing

`serveSite(component, versionId, worker?)` returns the handler of the site routes. It answers with
the file that matches, else with what `worker` answers (see
[Server-rendered pages](#server-rendered-pages)), else 404. Another method than GET or HEAD on a
path that has a file answers 405, as on Cloudflare; on any other path it goes to `worker`, else 404.
`worker` is the Worker script, an object with `fetch(request)`: the code that runs on a miss.
Everything it returns gets `Cache-Control: no-store`, and so does a 404, because the `*.convex.site`
front caches paths with an extension. The front keeps `no-store` for a path without an extension and
replaces it with a four-hour browser `max-age` for a path with one, so a browser that asks for a
script before its upload ended keeps the 404; the deploy order prevents that case, because no page
refers to a file that is not uploaded yet. When the version does not exist or is still uploading, it
answers 404 naming the version. At the first request for a new version, it marks the version live.

As on Cloudflare, the presence of code decides where `not_found_handling` (the single-page fallback
or the 404 page) applies:

- Without `worker`, the site is files only, like a Worker without a script: `not_found_handling`
  applies to every request. `curl`, uptime monitors, and link-preview bots get what a browser gets.
- With `worker`, your code is the Worker: `not_found_handling` applies to navigation requests
  (`Sec-Fetch-Mode: navigate`) only, and other requests that match no file reach your code. Browsers
  send that header whenever they open a page. `curl`, `fetch` in scripts and tests, uptime monitors,
  and link-preview bots do not. To test a deep link as a browser opens it, send the header:
  `curl -H "Sec-Fetch-Mode: navigate"`, or `node:http` in Node, whose `fetch` refuses to set it.

On a files-only single-page app, a missing hashed file such as `/assets/old.js` gets the shell, with
200 and `text/html`, as on Cloudflare. A `_headers` rule for its path applies to it too, so with the
one-year rule above a browser keeps that HTML for a year; without a rule, the deployment's
Cloudflare front gives a path with an extension a four-hour browser `max-age`. Hashed names do not
come back.

One difference from Cloudflare follows from Convex's router: an exact route in `convex/http.ts` wins
over an asset at the same path.

## Open tabs after a deploy

A page opened before a deploy keeps asking for its hashed files, which the new version does not
have, as on Cloudflare: they answer 404, or the shell on a files-only single-page app. To reload
open tabs on a new version, add a query that returns the bundled version:

```ts
// convex/siteVersion.ts
import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

export const get = query({ args: {}, returns: v.string(), handler: () => versionId });
```

and reload when its value changes after the first one:

```tsx
import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "../convex/_generated/api";

export function useReloadOnNewVersion() {
  const versionId = useQuery(api.siteVersion.get);
  const first = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (versionId === undefined) return;
    first.current ??= versionId;
    if (versionId !== first.current) location.reload();
  }, [versionId]);
}
```

## Server-rendered pages

`serveSite` takes a third argument, `worker`, the object with `fetch(request)` that the app's server
entry exports, and calls it when no file matches. `convex/http.ts` imports the server build
directly, such as `../dist/server/server.js` for TanStack Start, so `npx convex dev` bundles it only
after a build: on a fresh clone, the first `deploy --dev` builds before the first push (see
[Setup](#setup)).
[`@samebase/convex-hosting-tanstack-start`](https://github.com/samebase/convex-hosting/tree/main/packages/convex-hosting-tanstack-start)
renders TanStack Start pages in it. See the
[TanStack Start example](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr),
live at [gallant-llama-40.convex.site](https://gallant-llama-40.convex.site).

## The same app on Cloudflare Workers

[`examples/tanstack-ssr-workers`](https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr-workers)
is the TanStack Start example deployed as a Cloudflare Worker with static assets, with Convex still
the backend. Live at
[convex-hosting-tanstack-ssr-workers.pfp.workers.dev](https://convex-hosting-tanstack-ssr-workers.pfp.workers.dev).
[`examples/tanstack-ssr-workers.patch`](https://github.com/samebase/convex-hosting/blob/main/examples/tanstack-ssr-workers.patch)
is the diff between the two folders, and so the definition of what convex-hosting adds to an app. CI
writes the patch again from the committed folders and fails when it differs from the committed file;
`pnpm run examples:diff` refreshes it. The patch covers:

- `convex/http.ts`: on Convex only. It serves the files and forwards every other request to
  `src/server.ts`.
- `src/server.ts`: the same file on both hosts, the `/auth` routes and the session lines around the
  server entry, but for one line: the entry it wraps, the adapter's on Convex and TanStack Start's
  default on the Worker.
- `convex/convex.config.ts` and `convex/_generated/api.d.ts`: `app.use(hosting)` on Convex only.
- `vite.config.ts`: `convexSsr()` on Convex; Cloudflare's Vite plugin on the Worker.
- `package.json`: `@samebase/convex-hosting` and `convex-hosting deploy` on Convex; `wrangler`,
  `@cloudflare/vite-plugin`, and the Workers Builds scripts on the Worker.
- `wrangler.jsonc`: on the Worker only.
- `README.md`.

Workers Builds deploys it. Once, in the Cloudflare dashboard, create a Worker from this repository
with:

- Root directory: `examples/tanstack-ssr-workers`.
- Build command: `pnpm run build`. Deploy command: `pnpm run deploy`. Builds for non-production
  branches on, with the preview command `pnpm run deploy:preview`.
- Build variable `CONVEX_DEPLOY_KEY`: a production deploy key of the example's own Convex project in
  the production build variables, and the project's preview deploy key in Previews Base.
- Build variables `NODE_VERSION` `24.21.0` and `PNPM_VERSION` `12.10.1`, the versions this
  repository pins, in both. The Builds image defaults to Node 22.16.0, below the 22.18 that Vite+
  needs, and to pnpm 10.11.1.

The example's README describes the Convex side: the signing keys of production and of previews.

## License

Apache-2.0, with the notices in
[NOTICE](https://github.com/samebase/convex-hosting/blob/main/NOTICE). Not affiliated with or
endorsed by Convex. To work on this repository, see
[CONTRIBUTING.md](https://github.com/samebase/convex-hosting/blob/main/CONTRIBUTING.md).
