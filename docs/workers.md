# What differs from a Worker

The serving code is the same; the runtime around it is Convex's. Measured on the examples unless the
row names a document.

| On a Worker                                                                                                                                                                                                                                                    | On Convex                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The page renders in the data center nearest the visitor                                                                                                                                                                                                        | The deployment renders in its one region. The example's streamed page sends its first byte at 0.5 s from Europe where the Worker sends it at 0.1 s; a prerendered file answers from the front either way                                                                                                                                                           |
| Node's built-in modules, through `nodejs_compat`, on by default since 2026-08-04                                                                                                                                                                               | `process.env`, `AsyncLocalStorage`, and `AsyncResource`, per [Convex's runtime docs](https://docs.convex.dev/functions/runtimes); a dependency that imports `node:fs` or `node:crypto` does not bundle. A module that is imported but never run, such as TanStack's `node:stream`, gets a stub from the adapter; a module that must run needs a Convex Node action |
| `Cache-Control` from a page is honored at Cloudflare's edge                                                                                                                                                                                                    | The `*.convex.site` front bypasses its cache for rendered pages and only shapes browser caching, so a page cannot be cached at the edge                                                                                                                                                                                                                            |
| A server route can upgrade the connection to a WebSocket                                                                                                                                                                                                       | An HTTP action takes a request and returns a response, and nothing upgrades a connection. Live data goes over the Convex client's own connection, through subscribed queries                                                                                                                                                                                       |
| 128 MB of memory, no response cap, request bodies up to the plan's limit (100 MB on Free), CPU time of 10 ms on Free and 5 minutes on Paid with network waits uncounted, per [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/) | 64 MiB of memory, a 100 MiB response, no stated request limit, 30 minutes per request, per [Convex's limits](https://docs.convex.dev/production/state/limits)                                                                                                                                                                                                      |
| `env` bindings to KV, R2, D1, queues, and `request.cf`                                                                                                                                                                                                         | The deployment's own database, storage, scheduler, and crons, reached through the Convex client the server render already holds                                                                                                                                                                                                                                    |
| An asset at a path answers before any route                                                                                                                                                                                                                    | An exact route in `convex/http.ts` wins over an asset at the same path, by Convex's router                                                                                                                                                                                                                                                                         |

## Runtime

Convex's runtime is not workerd. An audit of every global that TanStack Start's server bundle
references (86 names) found one that Convex lacks and the bundle uses unguarded, `queueMicrotask`,
which `@samebase/convex-hosting` defines. `node:stream` is stubbed by the adapter's Vite plugin, for
a branch that never runs on Convex. The other differences are the rows of the table above.

## The same app on Cloudflare Workers

[`examples/tanstack-ssr-workers`](../examples/tanstack-ssr-workers) is the TanStack Start example
deployed as a Cloudflare Worker with static assets, with Convex still the backend. Live at
[convex-hosting-tanstack-ssr-workers.pfp.workers.dev](https://convex-hosting-tanstack-ssr-workers.pfp.workers.dev).
[`examples/tanstack-ssr-workers.patch`](../examples/tanstack-ssr-workers.patch) is the diff between
the two folders, without the READMEs and `convex/_generated`, and so the definition of what
convex-hosting adds to an app. CI writes the patch again from the committed folders and fails when
it differs from the committed file; `pnpm run examples:diff` refreshes it. The patch covers:

- `convex/http.ts`: on Convex only. It serves the files and forwards every other request to
  `src/server.ts`.
- `src/server.ts`: the same file on both hosts, the `/auth` routes and the session lines around the
  server entry, but for one line: the entry it wraps, the adapter's on Convex and TanStack Start's
  default on the Worker.
- `convex/convex.config.ts`: `app.use(hosting)` on Convex only. The generated `convex/_generated`
  files follow it and are left out of the patch.
- `vite.config.ts`: `convexSsr()` on Convex and Cloudflare's Vite plugin on the Worker, each next to
  `convexAuth()`.
- `package.json`: `@samebase/convex-hosting`, `@samebase/convex-hosting-tanstack-start`, and
  `convex-hosting deploy` on Convex; `wrangler`, `@cloudflare/vite-plugin`, and the Workers Builds
  scripts on the Worker.
- `wrangler.jsonc`: on the Worker only.

Workers Builds deploys it. Once, in the Cloudflare dashboard, create a Worker from this repository
with:

- Root directory: `examples/tanstack-ssr-workers`.
- Build command: `pnpm run build`. Deploy command: `pnpm run deploy`. Builds for non-production
  branches on, with the preview command `pnpm run deploy:preview`.
- Build variable `CONVEX_DEPLOY_KEY`: a production deploy key of the example's own Convex project in
  the production build variables, and the project's preview deploy key in Previews Base. Builds
  reads the Node and pnpm versions from the repository's `.node-version` and `packageManager`.

The example's README describes the Convex side: the signing keys of production and of previews.
