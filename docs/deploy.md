# Deploy

`deploy` runs `npx convex deploy` with your build and the upload of `--dist` as its `--cmd`. The
pushed code names the version it was built with, so the push switches the site. Then the command
prints the site URL, which it asks the deployment for (`CONVEX_SITE_URL`), and ends. The first
request that the new code serves marks its version live, which deletes the versions that were live
before it. A version that never becomes live, from a deploy that failed, is deleted when it is a day
old, with the stored files that no version uses. Nothing is deleted while a site gets no request.

`deploy` goes to production. `--preview-name <name>` sends it to that preview (with a login or a
project's preview deploy key; always pass the name with that key), and `--dev` to the development
deployment (see [Development](./development.md)). A deploy key in `CONVEX_DEPLOY_KEY` or
`CONVEX_DEPLOYMENT_TOKEN` (from the environment or `.env.local`) selects its own deployment instead,
and so does `CONVEX_SELF_HOSTED_URL` for a self-hosted deployment.

The first deploy to a deployment pushes the component, then uploads the files. Until that upload
ends, the site answers 404.

Run one deploy at a time per deployment; the examples'
[deploy workflow](https://github.com/samebase/convex-hosting/blob/main/.github/workflows/deploy-examples.yml)
queues them, with one `concurrency` group per deployment.

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

## Options

| Option                         | Values                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `--build "<command>"`          | The build to run before the upload; a site with no build omits it                      |
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
