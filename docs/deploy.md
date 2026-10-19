# Deploy

`deploy` runs `npx convex deploy` with your build and the upload of `--dist` as its `--cmd`. The
pushed code names the version it was built with, so the push switches the site. Then the command
prints the site URL, which it asks the deployment for (`CONVEX_SITE_URL`), and ends. The first
request that the new code serves marks its version live, which deletes the versions that were live
before it. A version that never becomes live, from a deploy that failed, is deleted at the first
switch after it is a day old, and the stored files that no version uses go at the switch after that.
Nothing is deleted while a site gets no request.

`deploy` goes to production. `--preview-name <name>` sends it to that preview (with a login or a
project's preview deploy key; always pass the name with that key), and `--dev` to the development
deployment (see [Development](./development.md)). A deploy key in `CONVEX_DEPLOY_KEY` or
`CONVEX_DEPLOYMENT_TOKEN` (from the environment or `.env.local`) selects its own deployment for a
plain `deploy`, and so does `CONVEX_SELF_HOSTED_URL` for a self-hosted deployment; `--dev` refuses a
key, and `--preview-name` accepts only a preview key, so a production key cannot redirect either.

The first deploy to a deployment pushes the component, then uploads the files. Until that upload
ends, the site answers 404.

Run one deploy at a time per deployment; in GitHub Actions, the job's `concurrency` group queues
them (see [GitHub Actions](#github-actions)).

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

  A failed first command stops before anything is stored. Where agents or outside collaborators open
  pull requests, keep the production key in an environment instead (see
  [The production key in an environment](#the-production-key-in-an-environment)).

- **A tool that runs `convex deploy` itself**, such as Alchemy's `Convex.Code`, has no place for the
  upload, which must happen between the build and the push. Run `convex-hosting deploy` in place of
  that tool's push step, with the deploy key in `CONVEX_DEPLOY_KEY`.
- **A deploy key limited to some actions** needs `deployment:deploy`,
  `deployment:functions:runInternalQueries`, `deployment:functions:runInternalMutations`,
  `deployment:functions:runInternalActions` (the upload calls one internal action),
  `deployment:functions:runTestQuery` (the first-install check and the site URL are inline queries),
  and `deployment:data:view` (`npx convex run`, which the upload uses for the internal functions, is
  refused without it).
- **Checks that must stop a release** run before `convex-hosting deploy`, because its push switches
  the site. Checks that need the new functions run after it.
- **A step that needs the site URL** reads it from the deploy step: when `GITHUB_OUTPUT` is set,
  `deploy` appends `url=<site URL>` to it.

## GitHub Actions

Three actions work for any Convex app, and each takes one key, `deploy-key`:

- [`actions/deploy`](../actions/deploy/action.yml) deploys to production. The key must start with
  `prod:`. Without a key, it deploys nothing and ends the step with a notice.
- [`actions/preview`](../actions/preview/action.yml) deploys a pull request to the preview named
  after its branch (`GITHUB_HEAD_REF` as it is, the name that `npx convex deploy` takes by default
  in GitHub Actions and that a Worker's Workers Builds preview uses). The key is the project's
  preview deploy key, which starts with `preview:`: `npx convex deploy` with a production key
  ignores `--preview-name` and deploys the pull request to production. Without a key, it deploys
  nothing and notes in the job how to get previews. A second push reuses the preview.
- [`actions/cleanup`](../actions/cleanup/action.yml) deletes that preview when the pull request
  closes, through the Convex management API, with the same preview key. A closed pull request then
  holds no deployment of the team's quota. A preview is known by its branch name alone, so give each
  repository its own Convex project. A branch renamed while its pull request is open deploys a new
  preview under the new name; the old one stays until Convex deletes it. Without a key, it deletes
  nothing.

`actions/deploy` and `actions/preview`:

- Run the `deploy` script of the app's `package.json`, or `npx convex deploy` when there is no such
  script. `actions/preview` appends `--preview-name <branch>`, which both commands take.
  `node --run` appends it to the script's last command, so the deploy command must end the script,
  and it runs no `predeploy` or `postdeploy` script.
- Fail before the deploy when the checkout is not the head of its branch (the pushed branch, or the
  pull request's), as `git ls-remote` reads it: a re-run of an old commit, or a merge commit, which
  `actions/checkout` takes by default on a pull request. So a re-run of an old run never puts older
  code over newer code. A re-run of a closed pull request's run deploys its preview again, until
  Convex deletes it.

Their outputs (the job summary lists the first three):

| Output           | Value                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `url`            | The site URL (`CONVEX_SITE_URL`), where HTTP actions answer                                |
| `deployment-url` | The deployment URL (`CONVEX_CLOUD_URL`), which a frontend build takes as `VITE_CONVEX_URL` |
| `dashboard-url`  | The deployment's page in the Convex dashboard, `https://dashboard.convex.dev/d/<name>`     |
| `preview-name`   | `actions/preview` only: the preview's name, for a later `npx convex run --preview-name`    |

The deployment gives both URLs to an inline query with the same key, so they are right in every
region. A plain Convex app whose key may not run inline queries still deploys; then the two URLs are
empty, with a warning, so a step that must follow every preview deploy checks `preview-name`, not
`url`. (`convex-hosting deploy` needs inline queries for its upload; see the deploy key permissions
above.) Every output is empty when nothing deployed. The workflows keep the install, the checks,
`concurrency`, `permissions`, and the secret names, and the input `working-directory` selects the
package. The actions need Node 22.3 or later for `node --run`, and `git`, `curl`, and `jq`, which
GitHub's runners have.

Two workflows deploy a plain Convex app. Two files keep each one a straight list of steps, and the
pull request's jobs never name the production key, so they never receive it.
`.github/workflows/deploy.yml` deploys `main` to production:

```yaml
on:
  push: { branches: [main] }
permissions: { contents: read }
jobs:
  production:
    runs-on: ubuntu-latest
    environment: { name: production, url: "${{ steps.deploy.outputs.url }}" }
    concurrency: { group: production, queue: max }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version: 24 }
      - run: npm ci
      - id: deploy
        uses: samebase/convex-hosting/actions/deploy@v1
        with: { deploy-key: "${{ secrets.CONVEX_DEPLOY_KEY }}" }
```

`.github/workflows/preview.yml` deploys each pull request to its preview and deletes it when the
pull request closes:

```yaml
on:
  pull_request: { types: [opened, synchronize, reopened, closed] }
jobs:
  preview:
    permissions: { contents: read, pull-requests: write }
    if:
      github.event.action != 'closed' && github.event.pull_request.head.repo.full_name ==
      github.repository
    runs-on: ubuntu-latest
    environment: { name: preview, url: "${{ steps.deploy.outputs.url }}" }
    concurrency: { group: "preview-${{ github.head_ref }}", queue: max }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { ref: "${{ github.event.pull_request.head.sha }}", persist-credentials: false }
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version: 24 }
      - run: npm ci
      - id: deploy
        uses: samebase/convex-hosting/actions/preview@v1
        with: { deploy-key: "${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}" }
  cleanup:
    permissions: { contents: read, pull-requests: write }
    if:
      github.event.action == 'closed' && github.event.pull_request.head.repo.full_name ==
      github.repository
    runs-on: ubuntu-latest
    concurrency: { group: "preview-${{ github.head_ref }}", queue: max }
    steps:
      - uses: samebase/convex-hosting/actions/cleanup@v1
        with: { deploy-key: "${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}" }
```

A `convex-hosting` app uses the same workflows and keeps its flags in its `deploy` script, such as
`convex-hosting deploy --build "vite build" --dist dist`; without that script, the plain
`npx convex deploy` leaves its site answering 404 (see [Rules](#rules)).

- `queue: max` keeps up to 100 pending runs of the group, in the order each began to wait. With the
  default, a new pending run replaces the older one, so a re-run of an old commit could replace the
  newest run, which would then never deploy. The cleanup shares the preview's group, so it waits for
  a running deploy of the branch instead of deleting the preview under it.
- The jobs' `if` skips a pull request from a fork, which gets no secrets.
- `actions/preview` keeps one comment on the pull request with the preview's links, which each
  deploy updates; `actions/cleanup` adds a line that the preview was deleted. A pull request without
  a preview gets no comment. The comment needs `pull-requests: write`, the only permission beyond
  `contents: read`; `comment: false` turns it off. Its header names the `working-directory`, so the
  cleanup passes the same one as the preview job.
- Pull requests share the `preview` environment, so when one deploys, GitHub marks the others'
  deployments inactive and hides their buttons; their comments keep the links.
- A re-run of an old cleanup deletes the preview even after a reopen; the next push deploys it
  again.
- The cleanup has no checkout, Node setup, or install: the delete needs none, and a broken install
  must not keep the preview.
- GitHub runs no `pull_request` workflow for a pull request with a merge conflict, or whose head
  commit's message has a skip instruction such as `[skip ci]`, so closing such a pull request keeps
  its preview until Convex deletes it.
- The `v1` tag comes with the actions' first release. Pin each action by its commit SHA, as any
  other.

### The production key in an environment

Optionally, one secret name serves both files: the production environment overrides the repository
secret of the same name. The repository secret `CONVEX_DEPLOY_KEY` then holds the preview key, the
`production` environment's `CONVEX_DEPLOY_KEY` holds the production key, and `preview.yml` passes
`secrets.CONVEX_DEPLOY_KEY` too. The production key then lives only in the environment, so a pull
request that edits the workflows cannot name it, once only `main` may deploy to that environment
(Settings, Environments, `production`, deployment branches). This matters where agents or outside
collaborators open pull requests.

```sh
gh api -X PUT "repos/{owner}/{repo}/environments/production" > /dev/null
key=$(npx convex deployment token create "<repository> deploy.yml" --prod) && printf '%s' "$key" | gh secret set CONVEX_DEPLOY_KEY --env production
```

Then store the preview key as the repository secret `CONVEX_DEPLOY_KEY` (the `curl` command above,
ending in `gh secret set CONVEX_DEPLOY_KEY`). The environment's name is the caller's choice; a
repository that already has one, such as `Production`, keeps it (GitHub compares environment names
without case).
