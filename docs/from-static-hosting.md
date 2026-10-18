# From static-hosting

Convex's own [static-hosting](https://github.com/convex/static-hosting) component serves the files
of a build, and does that well. This package started from it and exists for frameworks that render
pages on the server, such as TanStack Start, so it needed a different serving model: Cloudflare's
rules for files, and a deploy that switches code and files together. Both keep the files in the
component's Convex file storage, upload them through the Convex CLI, and serve them at
`https://<deployment>.convex.site`. What this page says about static-hosting comes from its README
and source on 2026-10-18, version 0.2.1.

## What differs

|               | static-hosting                                                                                                                                                      | convex-hosting                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages         | Files only                                                                                                                                                          | What no file answers goes to the app's server entry, an object with `fetch(request)`; TanStack Start has an [adapter](../packages/convex-hosting-tanstack-start)                                                              |
| File rules    | Its own: a miss without an extension gets `index.html` unless deployed with `--no-spa`, and a miss with one is 404. Hashed file names get a one-year cache          | Cloudflare's asset Worker: `_headers`, `_redirects`, `.assetsignore`, `html_handling`, and `not_found_handling` (see [Serving](./serving.md)). Every file revalidates unless `_headers` says otherwise                        |
| Routes        | The component owns `/`, with the app's routes under `/api`, or a sub-path; or `registerStaticRoutes` adds a GET catch-all to `convex/http.ts`                       | `routeAll` adds a catch-all for every method to `convex/http.ts`, and exact routes win over it. There is no sub-path option                                                                                                   |
| Deploy        | Build, `npx convex deploy`, then upload. The upload's last mutation switches the files and deletes the previous ones, so code and files switch at different moments | Upload a new version, then push code that names it. The push switches code and files together, and the first request on the new code deletes the versions live before it ([how](../README.md#how-a-deploy-switches-the-site)) |
| CLI           | `setup`, `deploy`, and `upload`; `--dist` defaults to `./dist` and `--build-command` to `npm run build`                                                             | `deploy`, with `--dist` required and `--build` optional; `--dev` and `--preview-name` pick the deployment ([options](./deploy.md#options))                                                                                    |
| Reload prompt | `UpdateBanner` and `useDeploymentUpdates`                                                                                                                           | A query and a hook to copy, in [Development](./development.md#open-tabs-after-a-deploy)                                                                                                                                       |

## How to move

[Scout](https://github.com/samebase/scout) moved this way in
[samebase/scout#220](https://github.com/samebase/scout/pull/220), after a first step in
[samebase/scout#219](https://github.com/samebase/scout/pull/219).

1. Install `@samebase/convex-hosting`.
2. In `convex/convex.config.ts`, replace the `app.use(staticHosting)` line with `app.use(hosting)`,
   as in [Use](../README.md#use). If the component owned `/`, also remove `httpPrefix: "/api"` from
   `defineApp`, and add `/api` to the paths of your own routes whose URLs must stay.
3. In `convex/http.ts`, replace `registerStaticRoutes(...)` with
   `routeAll(http, components.hosting, versionId)`, and import `versionId` from
   `../.convex-hosting/version.js`. Your exact routes keep winning. A server-rendered app passes its
   server entry as the fourth argument.
4. In the deploy scripts, replace `@convex-dev/static-hosting deploy`, or the pair
   `npx convex deploy` and `upload --prod`, with
   `convex-hosting deploy --build "<build command>" --dist <dir>`, which builds, uploads, and pushes
   to production. Remove any other `npx convex deploy` from the sequence, as the
   [deploy rules](./deploy.md#rules) explain. An `upload` without `--prod` went to development, so
   it becomes `convex-hosting deploy --dev`, which also pushes the functions there. For
   static-hosting's default SPA fallback, add `--not-found-handling single-page-application`. For
   `--no-spa`, add nothing, or `--not-found-handling 404-page` to serve your `404.html`.
5. Replace `UpdateBanner` or `useDeploymentUpdates` with the query in
   [Development](./development.md#open-tabs-after-a-deploy), and delete `convex/staticHosting.ts`.
6. Uninstall `@convex-dev/static-hosting`.
7. Deploy development with the two-terminal first run in [Use](../README.md#use), then production
   with `convex-hosting deploy`. The first deploy to a deployment installs the component before it
   uploads, so the site answers 404 until the upload ends.

Then check three things:

- **Caching.** Add the `/assets/*` rule from [Serving](./serving.md) to `_headers`. Without it,
  hashed files revalidate on every load.
- **Paths.** `html_handling` and `_redirects` now decide URLs as on Cloudflare. A single-page app
  without a server entry answers a missing file with an extension, such as `/assets/old.js`, with
  `index.html`, where static-hosting answered 404.
- **Old files.** The push that removes `app.use(staticHosting)` unmounts that component, and its
  files stay until you delete it in the Convex dashboard. From then on, each deploy's first request
  deletes the version that was live before it.
