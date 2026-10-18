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

[`actions/deploy`](../actions/deploy/action.yml) is a Convex deploy action whose pull request
previews are deleted when the pull request closes. It works for any Convex app, and takes the
production key in `deploy-key` and the project's preview deploy key in `preview-deploy-key`:

- It runs the `deploy` script of the app's `package.json`, or `npx convex deploy` when there is no
  such script. On a pull request it appends `--preview-name <branch>`, which both commands take.
  `node --run` appends it to the script's last command, so the deploy command must end the script,
  and it runs no `predeploy` or `postdeploy` script.
- On a push, it deploys to production with `deploy-key`, which must start with `prod:`.
- On a pull request, it deploys to the preview named after the pull request's branch
  (`GITHUB_HEAD_REF` as it is, the name that `npx convex deploy` takes by default in GitHub Actions
  and that a Worker's Workers Builds preview uses) with `preview-deploy-key`, which must start with
  `preview:`: `npx convex deploy` with a production key ignores `--preview-name` and deploys the
  pull request to production. Without `preview-deploy-key`, it uses `deploy-key` when that is a
  preview key (see [The production key in an environment](#the-production-key-in-an-environment)),
  and with neither it deploys nothing and notes in the job how to get previews. A second push reuses
  the preview.
- It shows the preview on the pull request as a deployment, which it creates through GitHub's API
  after each deploy: transient, in the environment `preview` (the input `environment`; each app of a
  repository with several gives its own), with the branch as its ref and the site URL as its link.
  GitHub keeps a transient deployment active when another pull request deploys in the same
  environment, so every open pull request keeps its link, and the repository gets one environment
  for its previews, not one per branch.
- When the pull request closes, it deletes that preview through the Convex management API, with the
  same preview key, unless another open pull request has the same branch. A closed pull request then
  holds no deployment of the team's quota. It also marks the branch's deployments inactive, so the
  pull request links to no deleted preview. A preview is known by its branch name alone, so give
  each repository its own Convex project. A branch renamed while its pull request is open deploys a
  new preview under the new name; the old one stays until Convex deletes it.
- Before a deploy, it fails when the commit is no longer the head of its branch, when the checkout
  is another commit (on a pull request, `actions/checkout` takes a merge commit by default), or when
  the pull request is closed. So a re-run of an old run never puts older code over newer code.

Its outputs (the job summary lists the first three):

| Output           | Value                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `url`            | The site URL (`CONVEX_SITE_URL`), where HTTP actions answer; the pull request's link       |
| `deployment-url` | The deployment URL (`CONVEX_CLOUD_URL`), which a frontend build takes as `VITE_CONVEX_URL` |
| `dashboard-url`  | The deployment's page in the Convex dashboard, `https://dashboard.convex.dev/d/<name>`     |
| `preview-name`   | The preview's name, for a later `npx convex run --preview-name`; empty on production       |

The deployment gives both URLs to an inline query with the same key, so they are right in every
region. A plain Convex app whose key may not run inline queries still deploys; then the two URLs are
empty, with a warning, so a step that must follow every deploy checks the event or `preview-name`,
not `url`. (`convex-hosting deploy` needs inline queries for its upload; see the deploy key
permissions above.) Every output is empty on a close and when nothing deployed. The job keeps the
install, the checks, `concurrency`, `permissions`, and the secret names, and the input
`working-directory` selects the package. The action needs Node 22.3 or later for `node --run`, and
`gh`, `curl`, and `jq`, which GitHub's runners have. This workflow deploys a plain Convex app:

```yaml
on:
  push: { branches: [main] }
  pull_request: { types: [opened, synchronize, reopened, closed] }
permissions: { contents: read, pull-requests: read, deployments: write }
jobs:
  deploy:
    if: github.event.pull_request.head.repo.full_name == github.repository || !github.head_ref
    runs-on: ubuntu-latest
    concurrency:
      group: deploy ${{ github.head_ref && format('preview/{0}', github.head_ref) || 'production' }}
      queue: max
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { ref: "${{ github.event.pull_request.head.sha }}", persist-credentials: false }
      - if: github.event.action != 'closed'
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version: 24 }
      - if: github.event.action != 'closed'
        run: npm ci
      - id: deploy
        uses: samebase/convex-hosting/actions/deploy@v1
        with:
          deploy-key: ${{ secrets.CONVEX_DEPLOY_KEY }}
          preview-deploy-key: ${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}
```

A `convex-hosting` app uses the same workflow and keeps its flags in its `deploy` script, such as
`convex-hosting deploy --build "vite build" --dist dist`; without that script, the plain
`npx convex deploy` leaves its site answering 404 (see [Rules](#rules)).

- `queue: max` keeps up to 100 pending runs of the group, in the order each began to wait. With the
  default, a new pending run replaces the older one, so a re-run of an old commit could replace the
  newest run, which would then never deploy. The group of a branch named `production` is not the
  production group.
- The job's `if` skips a pull request from a fork, which gets no secrets.
- On a closed pull request the job skips the install: the delete needs none, and a broken install
  must not keep the preview. It skips the Node setup too: with `cache: npm` or `cache: pnpm`, the
  setup's post step fails on a run without an install, because the folder that it caches is missing.
- GitHub runs no `pull_request` workflow for a pull request with a merge conflict, or whose head
  commit's message has a skip instruction such as `[skip ci]`, so closing such a pull request keeps
  its preview until Convex deletes it.
- To post the URL as a comment too, add `pull-requests: write` to `permissions` and this step after
  the deploy:

  ```yaml
  - if: steps.deploy.outputs.url
    uses: marocchino/sticky-pull-request-comment@5770ad5eb8f42dd2c4f34da00c94c5381e49af88 # v3.0.5
    with:
      message: "Preview: ${{ steps.deploy.outputs.url }}"
  ```

- The `v1` tag comes with the action's first release. Pin the action by its commit SHA, as any
  other.

### The production key in an environment

With the two repository secrets, a pull request's job receives the production key too. A job gets
every secret that it names, and it runs the pull request's install, build, and deploy script, so
that code can reach the key (for example in the runner's memory), although the deploy step gets only
the preview key. Where agents or outside collaborators open pull requests, keep the production key
in the `production` environment, under the name that the repository secret uses for the preview key:
one `CONVEX_DEPLOY_KEY` with a value per environment, as in
[Convex's Vercel and Netlify setup](https://docs.convex.dev/production/multiple-deployments#preview).
Create the environment and its secret:

```sh
gh api -X PUT "repos/{owner}/{repo}/environments/production" > /dev/null
key=$(npx convex deployment token create "<repository> deploy.yml" --prod) && printf '%s' "$key" | gh secret set CONVEX_DEPLOY_KEY --env production
```

Then store the preview key as the repository secret `CONVEX_DEPLOY_KEY` (the `curl` command above,
ending in `gh secret set CONVEX_DEPLOY_KEY`), delete `CONVEX_PREVIEW_DEPLOY_KEY`, remove the
`preview-deploy-key` line, and give the job the environment on a push:

```yaml
environment:
  name: ${{ github.event_name == 'push' && 'production' || '' }}
  url: ${{ steps.deploy.outputs.url }}
```

In that job only, the environment's secret takes the place of the repository's, so `deploy-key` is
the production key on a push and the preview key on a pull request. To keep a workflow edit on
another branch from naming the environment, allow only `main` in its deployment branches. The
environment's name is the caller's choice; a repository that already has one, such as `Production`,
keeps it (GitHub compares environment names without case).

Matrix test Y, throwaway.
