# Proposal: a reusable GitHub Action for deploys and previews

Status: not approved, 2026-10-18. Written by an AI assistant for
[#84](https://github.com/samebase/convex-hosting/issues/84), from the workflows of this repository
at `98fd54c`, of Mail, ChessMerge, and Scout, and from the sources linked below, then revised after
one Codex design review (the last section). Nothing is implemented. The decisions that only the
maintainer can make are listed at the end.

## The problem

Each app that deploys with `convex-hosting` carries the same production and preview jobs:

| Repository                                                    | Files                                         | Lines | Without blank lines and comments |
| ------------------------------------------------------------- | --------------------------------------------- | ----- | -------------------------------- |
| This repository, examples                                     | `deploy-examples.yml`, `preview-examples.yml` | 165   | 130                              |
| Mail (`samebase/convex-cloudflare-email-inbox`)               | `deploy.yml`, two jobs                        | 139   | 98                               |
| ChessMerge (`nicu-chiciuc/chessmerge`)                        | `deploy.yml`, `preview.yml`                   | 119   | 93                               |
| Scout ([`samebase/scout`](https://github.com/samebase/scout)) | `deploy.yml`, `preview.yml`                   | 134   | 101                              |

What every copy has: checkout with `persist-credentials: false`, the package manager and Node,
`pnpm install --frozen-lockfile`, a check that the commit is still the head of its branch, the
deploy with `CONVEX_DEPLOY_KEY` from a secret, `--preview-name "$GITHUB_HEAD_REF"` with the
project's preview deploy key on a pull request, the site URL from `steps.<id>.outputs.url`, one
comment with that URL, a `concurrency` group per deployment, and a job `if` that skips pull requests
from forks. Mail runs its checks and a Convex Auth key step in the same job; Scout seeds an account
and sets `SITE_URL` after the deploy.

The cost is drift more than length. The head check exists in three forms: inline `gh api` (the
examples, ChessMerge), a Node script with `git ls-remote` and arguments (Mail), and a Node script
that compares `git rev-parse HEAD` with the branch, which needs a head checkout (Scout). The comment
exists in two: `gh pr comment --edit-last --create-if-none` (Mail, ChessMerge, Scout) and a prefix
match (the examples, because `--edit-last` edits the last comment of the token's user, whatever it
says, so a matrix edits the wrong one). The examples had no head check until the ChessMerge review
found the gap ([#33](https://github.com/samebase/convex-hosting/issues/33), item 3). And every copy
shares a gap that the review of this note found: GitHub keeps one pending run per `concurrency`
group, so a re-run of an old commit can cancel the newest one (see
[The head check and `concurrency`](#the-head-check-and-concurrency)).

## What the actions own, and what they must not

Two composite actions in one folder tree, because the comment must be able to come after the app's
own setup:

- `actions/deploy` owns the steps that every deploy needs and that `convex-hosting` defines:
  1. The head check: refuse a run whose commit is not the head of its branch, or is not what was
     checked out.
  2. The deploy: run the app's deploy script with the key in `CONVEX_DEPLOY_KEY`, on that step only,
     and with `--preview-name` for a preview.
  3. The site URL, as an output.
- `actions/preview-comment` owns the one comment with the preview URL. Mail creates its Convex Auth
  keys and Scout seeds an account and sets `SITE_URL` after the deploy; both comment last today, so
  a reviewer never opens a preview that is not ready, and a failed comment never skips that setup.

They must not own:

- **The app's tests and checks.** The maintainer's rule. They run in the caller's job before the
  deploy, because the push switches the site ([Deploy](../deploy.md), "Deploy tools and CI").
- **Install and the toolchain.** Checkout, Node, the package manager, and install are the caller's.
  The action runs the `convex-hosting` that the app's lockfile installed, so it never installs the
  CLI and the two versions stay separate. `cloudflare/wrangler-action` does the same when Wrangler
  is already installed.
- **Build configuration.** `--build`, `--dist`, and the handling options stay in the app's
  `package.json` `deploy` script, which `deploy:dev` mirrors for local use (decision 4).
- **Job-level settings.** Triggers, the fork guard, `concurrency`, `permissions`, `environment`, the
  runner, and the timeout. A composite action cannot set them: its metadata has only `name`,
  `author`, `description`, `inputs`, `outputs`, `runs`, and `branding`
  ([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runs-for-composite-actions)).
- **Secret names.** The caller passes the key as an input. A composite action cannot read the
  `secrets` context at all
  ([contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#secrets-context)).
- **The app's own steps after the deploy.** They sit between the two actions and read the deploy's
  `url` output.

## Prior art

| Action                                                                                             | Shape                                              | Credential               | URL output                      | Comment                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------ | ------------------------------- | -------------------------------------------------------------------- |
| [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action/blob/main/action.yml) | JavaScript, `node24`; `dist` built at release only | `apiToken` input         | `deployment-url`, `preview-url` | None; with `gitHubToken`, a GitHub Deployment (`deployments: write`) |
| [`nwtgck/actions-netlify`](https://github.com/nwtgck/actions-netlify/blob/develop/action.yml)      | JavaScript, `node24`, `dist` committed             | `NETLIFY_AUTH_TOKEN` env | `deploy-url`                    | Built in, on by default; finds its comment by a hidden marker        |
| [`amondnet/vercel-action`](https://github.com/amondnet/vercel-action/blob/master/action.yml)       | JavaScript, `node24`, `dist` committed             | `vercel-token` input     | `preview-url`                   | Built in, on by default; finds its comment by a body prefix          |

- `wrangler-action` takes a `command` (default `deploy`), `workingDirectory`, `packageManager` (else
  detected from the lockfile), and `wranglerVersion`; it reads the URL from the file that Wrangler
  writes to `WRANGLER_OUTPUT_FILE_DIRECTORY`, not from stdout. It is versioned with immutable
  `vX.Y.Z` releases and a moving `v4`. `cloudflare/pages-action`, its predecessor, is deprecated and
  gone.
- Netlify and Vercel publish no official action. Netlify's
  [CLI guide](https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/) installs
  `netlify-cli` as a dev dependency and runs `netlify deploy` in CI; Vercel's
  [guide](https://vercel.com/guides/how-can-i-use-github-actions-with-vercel) runs `vercel pull`,
  `vercel build`, and `vercel deploy --prebuilt`, and says a custom step must post preview URLs.
- Convex publishes no action. The Marketplace search for "convex" returns nothing, and none of the
  repositories of the `convex` organization is one. Its CI story is the host's build command:
  `npx convex deploy --cmd 'npm run build'`
  ([Vercel](https://docs.convex.dev/production/hosting/vercel),
  [Netlify](https://docs.convex.dev/production/hosting/netlify)).
- Sticky comments: [`peter-evans/find-comment`](https://github.com/peter-evans/find-comment) plus
  [`create-or-update-comment`](https://github.com/peter-evans/create-or-update-comment) (author and
  body match, two actions), or
  [`marocchino/sticky-pull-request-comment`](https://github.com/marocchino/sticky-pull-request-comment)
  (a hidden marker and the token's user). `gh pr comment --edit-last` "Edit the last comment of the
  current user" ([manual](https://cli.github.com/manual/gh_pr_comment)), with no body match.

What carries over: the credential is an input from the caller's secret; the URL is an output; the
comment, where an action has one, finds its own comment by a marker or a prefix, not by "the last
one".

## The preview name

- The Convex CLI already names a preview after the branch: in CI it reads `GITHUB_HEAD_REF` and
  passes it unchanged (`gitBranchFromEnvironment` in `convex` 1.46.0, `src/cli/lib/envvars.ts`).
  `--preview-name` "Reuses the existing deployment if one exists"
  ([deploy reference](https://docs.convex.dev/cli/reference/deploy)).
- `convex-hosting deploy` does not read `GITHUB_HEAD_REF`. It needs `--preview-name` to know that
  the target is a preview, because it passes the name to every `npx convex run` of the upload.
- Convex documents no length or character rule for preview names. Slashes and dots work: branch
  `renovate/undici-8.x` deployed its previews in
  [run 39123970220](https://github.com/samebase/convex-hosting/actions/runs/39123970220). The name
  never reaches a host name: that preview's URL is `capable-antelope-100.convex.site`.
- A preview lives 5 days (Free and Starter) or 14 days (Professional and up) after it is created
  ([multiple deployments](https://docs.convex.dev/production/multiple-deployments)).

Candidates: the branch name as it is (today, and the Convex CLI's own default, so a branch reaches
the same preview from any tool); `pr-<number>` (stable if the branch is renamed, but not what the
dashboard shows for other tools); a sanitized branch (no evidence that one is needed). Proposed: the
branch as it is, as the `preview-name` input's default, which a caller can replace.

## The head check and `concurrency`

The head check belongs in the action. It is one step that needs only the event and a token, and it
is the same for every app. It compares the commit that the event names
(`github.event.pull_request.head.sha`, or `GITHUB_SHA` on a push) with the branch's head from the
API, which works in a private repository, where `git ls-remote` after `persist-credentials: false`
has no credentials. A re-run uses the same `GITHUB_SHA` as the original
([re-running](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)),
which is what the check catches.

The check also requires that the checkout is that commit. On `pull_request`, `actions/checkout`
takes the merge commit by default, and one head gives a new merge commit each time the base moves. A
re-run of an older run then has the same head and passes a head-only check, and its push serves the
older base over the newer preview. So the caller checks out the head
(`ref: ${{ github.event.pull_request.head.sha }}`, as Scout does), the action fails on any other
checkout, and the preview is the branch that Convex names it after.

`concurrency` stays with the caller: it is a job key. It is required for correctness, not only for
order. Without it, an older run can pass the check before the newer commit exists, and finish its
push after the newer run, so the older code wins. And the default group is not enough: it holds one
running and one pending run, and a new pending run replaces the older pending one
([concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)).
While commit A deploys and the newest commit C waits, a re-run of an older commit B replaces C; B
then fails the head check, and C is never deployed. `queue: max` keeps up to 100 pending runs and
starts them in the order they began to wait; it cannot be combined with `cancel-in-progress: true`
([controlling concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)).
With it, B waits, fails its check, and C deploys. The docs show `queue` only in workflow-level
examples, though the job-level section lists it too; the first adopter confirms it at job level. The
action's README gives the group with `queue: max`.

## The comment

Proposed: `actions/preview-comment`, about ten lines of `gh api`, no third-party action. The comment
starts with a hidden marker that holds its title, so a matrix of apps in one pull request keeps one
comment each. The action has no token input: it always uses `github.token`, so its comments are
always by `github-actions[bot]`, and the search keeps only that author's comments, so a pasted
marker cannot redirect the edit. The job needs `pull-requests: write` or `issues: write`; either is
enough ([create](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment) and
[update](https://docs.github.com/en/rest/issues/comments#update-an-issue-comment) an issue comment).
A pull request from a fork gets a read-only token and no secrets
([forks](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories)),
so its job does not run and nothing is posted.

Alternative: the job's `environment` with `url: ${{ steps.deploy.outputs.url }}`, which records a
deployment that the pull request shows and needs no comment permission
([environment](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idenvironment)).
`wrangler-action` takes this road through the Deployments API. It combines with the protected
environments under [Secrets](#secrets).

## Secrets

- One input, `deploy-key`. The caller chooses the secret:
  `${{ github.event_name == 'push' && secrets.CONVEX_DEPLOY_KEY || secrets.CONVEX_PREVIEW_DEPLOY_KEY }}`.
  The action names no secret. Not two inputs with the action choosing: every preview run would then
  hold the production key without any reason.
- The key goes only into the deploy step's environment, never into `$GITHUB_ENV`, so install and the
  checks never see it. The build runs inside the deploy and sees it, as today.
- This selection prevents mistakes, not misuse. A `pull_request` run uses the workflow file of the
  pull request's branch, so anyone who can push a branch can make that run read
  `secrets.CONVEX_DEPLOY_KEY`. With repository secrets, writers are trusted with the production key,
  as they are today.
- To keep the production key from pull request runs, put each key in an environment: a `production`
  environment whose deployment branches are only `main` holds the production key, and a `preview`
  environment holds the preview key, both as `CONVEX_DEPLOY_KEY`. The branch rule is matched against
  `GITHUB_REF`, which is `refs/pull/<n>/merge` for a pull request run, so such a run cannot use the
  production environment
  ([environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
  The job then reads one name:

  ```yaml
  environment:
    name: ${{ github.event_name == 'push' && 'production' || 'preview' }}
    url: ${{ steps.deploy.outputs.url }}
  # ...
  deploy-key: ${{ secrets.CONVEX_DEPLOY_KEY }}
  ```

- An empty key fails with a message that names forks. A production key with `--preview-name` is
  refused by the CLI from 0.12.0, so the action's README requires 0.12.0 or later.

## Candidate shapes

### A. Two composite actions (proposed)

ChessMerge's two files after the change, both events in one job:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  deploy:
    # A pull request from a fork gets no secrets.
    if:
      github.event_name == 'push' || github.event.pull_request.head.repo.full_name ==
      github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write # the preview comment
    # One deploy at a time per deployment, and no pending run replaced by a re-run.
    concurrency:
      group: deploy-${{ github.event.pull_request.number || 'production' }}
      queue: max
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - id: deploy
        uses: samebase/convex-hosting/actions/deploy@<full sha> # v1.0.0
        with:
          deploy-key:
            ${{ github.event_name == 'push' && secrets.CONVEX_DEPLOY_KEY ||
            secrets.CONVEX_PREVIEW_DEPLOY_KEY }}
      - uses: samebase/convex-hosting/actions/preview-comment@<full sha> # v1.0.0
        with:
          url: ${{ steps.deploy.outputs.url }}
```

46 lines as formatted, 41 without blank lines and comments, against 119 and 93 today. With the
environments from [Secrets](#secrets), the key line shortens and the job gains three lines. Two
jobs, so that the production job has no `pull-requests: write`, cost about 20 more lines. Mail keeps
its `check` before the deploy and its Convex Auth step between the two actions, in the same job. The
examples' two files (165 lines) become one of about 55, with `uses: ./actions/deploy`, a matrix of
three, and a `working-directory` and a comment `title` per example.

### B. A reusable workflow

It owns the whole job: runner, timeout, the permission ceiling, `concurrency`, the fork guard,
checkout, the toolchain, install, and the same steps. The caller:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  deploy:
    uses: samebase/convex-hosting/.github/workflows/deploy.yml@<full sha> # v1.0.0
    permissions:
      contents: read
      pull-requests: write
    with:
      node-version: "24"
      package-manager: pnpm
    secrets:
      deploy-key:
        ${{ github.event_name == 'push' && secrets.CONVEX_DEPLOY_KEY ||
        secrets.CONVEX_PREVIEW_DEPLOY_KEY }}
```

24 lines as formatted, 21 without blank lines and comments. Its strongest argument follows from the
section above: `concurrency` with `queue: max` is needed for correctness, and only this shape can
own it. What it costs
([reusing workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)):

- It owns install, against the line above, and every app's install differs: the package manager and
  its version, the Node version, Mail's `component:build`. Each difference becomes an input.
- A job that calls a reusable workflow takes only `name`, `uses`, `with`, `secrets`, `strategy`,
  `needs`, `if`, `concurrency`, `permissions`, and `cache-mode`: no steps before or after. The
  called workflow can take commands as inputs and run them in its own job, before and after the
  deploy, on the same checkout. Then Mail's checks and Convex Auth keys and Scout's seed and
  `SITE_URL` become strings, and the deploy key and the URL that those commands need go through its
  inputs too.
- The file must sit directly in `.github/workflows/` of this repository, and a reusable workflow
  cannot be listed on the Marketplace.
- Inside it, `github.workflow` is the caller's name, so its `concurrency` group must be built from
  inputs to avoid colliding with the caller's.

### C. Documentation only

`docs/deploy.md` carries the job to copy, the alternative that #84 names. Nothing to version, and
each app keeps about 93 lines and its own drift.

### Not proposed: a JavaScript action

The same ownership as A, in TypeScript bundled into a committed file: GitHub's tutorial requires the
dependencies in the action and commits `dist/index.js`
([JavaScript action](https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action#commit-tag-and-push-your-action)),
and `runs.using` is `node20` or `node24`. A build artifact in the repository is worth it only when
the logic outgrows a few lines of shell, for example calls to the Deployments API or preview
cleanup.

## The actions, sketched

`actions/deploy/action.yml`:

```yaml
name: convex-hosting deploy
description: >-
  Runs the app's convex-hosting deploy script to production, or to a preview named after the pull
  request branch, after it checks that the checked-out commit is still the head of its branch.
inputs:
  deploy-key:
    description: >-
      The Convex deploy key, from a secret: the production key for production, the project's preview
      deploy key for a preview.
    required: true
  working-directory:
    description: The directory of the package.json whose script runs convex-hosting deploy.
    default: .
  script:
    description: The package.json script that runs convex-hosting deploy with the app's flags.
    default: deploy
  preview-name:
    description: The preview deployment's name. Empty deploys to production.
    default: ${{ github.head_ref }}
outputs:
  url:
    description: The site URL that the deploy reported.
    value: ${{ steps.deploy.outputs.url }}
runs:
  using: composite
  steps:
    # A re-run of an old run checks out its old commit, and its push would put older code over
    # newer code. The caller's concurrency group orders runs; this refuses a stale one.
    - name: Check that the checkout is the head of its branch
      shell: bash
      env:
        GH_TOKEN: ${{ github.token }}
        PR: ${{ github.event.pull_request.number }}
        SHA: ${{ github.event.pull_request.head.sha || github.sha }}
        BRANCH: ${{ github.ref_name }}
      run: |
        if [ "$(git rev-parse HEAD)" != "$SHA" ]; then
          echo "::error::The checkout is not $SHA. Give actions/checkout the pull request's head commit as its ref."
          exit 1
        fi
        if [ -n "$PR" ]; then
          head=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR" --jq .head.sha)
        else
          head=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$BRANCH" --jq .object.sha)
        fi
        if [ "$head" != "$SHA" ]; then
          echo "::error::$SHA is stale: its branch now points to $head. Convex was not deployed."
          exit 1
        fi

    - name: Deploy
      id: deploy
      shell: bash
      working-directory: ${{ inputs.working-directory }}
      env:
        CONVEX_DEPLOY_KEY: ${{ inputs.deploy-key }}
        SCRIPT: ${{ inputs.script }}
        PREVIEW_NAME: ${{ inputs.preview-name }}
      run: |
        if [ -z "$CONVEX_DEPLOY_KEY" ]; then
          echo "::error::deploy-key is empty. A pull request from a fork gets no secrets; skip its job."
          exit 1
        fi
        if [ -n "$PREVIEW_NAME" ]; then
          node --run "$SCRIPT" -- --preview-name "$PREVIEW_NAME"
        else
          node --run "$SCRIPT"
        fi
```

`actions/preview-comment/action.yml`:

```yaml
name: convex-hosting preview comment
description: >-
  On a pull request, posts the preview URL in one comment and edits that comment on later runs.
inputs:
  url:
    description: The preview URL, from the deploy action's url output.
    required: true
  title:
    description: The text before the URL; one comment per title.
    default: Preview
runs:
  using: composite
  steps:
    - name: Post the preview URL
      if: github.event.pull_request.number && inputs.url
      shell: bash
      env:
        GH_TOKEN: ${{ github.token }}
        PR: ${{ github.event.pull_request.number }}
        MARKER: "<!-- convex-hosting preview: ${{ inputs.title }} -->"
        BODY: "${{ inputs.title }}: ${{ inputs.url }}"
      run: |
        id=$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR/comments" --paginate --jq \
          '.[] | select(.user.login == "github-actions[bot]" and (.body | startswith($ENV.MARKER))) | .id' | head -n 1)
        if [ -n "$id" ]; then
          gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$MARKER $BODY" > /dev/null
        else
          gh api "repos/$GITHUB_REPOSITORY/issues/$PR/comments" -f body="$MARKER $BODY" > /dev/null
        fi
```

Notes on the sketches:

- `node --run` runs a `package.json` script without knowing the package manager. It walks up to the
  nearest `package.json`, prepends each ancestor's `node_modules/.bin` to `PATH`, appends the
  arguments after `--`, and runs no `pre` or `post` script
  ([Node CLI](https://nodejs.org/api/cli.html#--run)). `--run` exists from Node 22.0 and looks in
  parent folders from 22.3; the package's `engines` ask for Node 22. `node --run deploy -- --help`
  in `examples/tanstack-spa` reaches the CLI's help.
- The actions require `convex-hosting` 0.12.0 or later: it writes `url=` to `$GITHUB_OUTPUT` (from
  0.8.0) and refuses a production key with `--preview-name` (from 0.12.0). Their whole interface
  with the CLI is the script name, `--preview-name`, and that output line, so CLI flag changes do
  not reach them.
- Every expression that holds outside text reaches the shell through `env`, not inline in `run`.
  `gh` is on GitHub-hosted runners; a self-hosted runner needs it.

## Where they live and how they are versioned

- **Reference.** A public action in a subfolder is `{owner}/{repo}/{path}@{ref}`
  ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#example-using-a-public-action-in-a-subdirectory)),
  so `samebase/convex-hosting/actions/deploy@<ref>`. This repository's examples use
  `uses: ./actions/deploy`, so every pull request here deploys three previews through the actions at
  their own commit before any release: the main reason to keep them in this repository.
- **Marketplace.** A listing needs a public repository with a single action metadata file at its
  root; files in subfolders are not listed
  ([publishing](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace#prerequisites)).
  GitHub recommends a dedicated repository for an action meant to be shared
  ([choosing a location](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/manage-custom-actions#choosing-a-location-for-your-action)),
  but does not require one: [`crate-ci/typos`](https://github.com/crate-ci/typos) keeps a root
  `action.yml` next to its Rust source and ten workflows, and is listed. So the deploy action at the
  root of this repository (`uses: samebase/convex-hosting@<ref>`) could be listed too, while the
  comment action stays in a subfolder. None of the current callers needs a listing.
- **Tags.** GitHub's guidance is a semver release tag per version and a moving major tag
  ([release management](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/manage-custom-actions#using-release-management-for-actions)),
  with an immutable release for each fixed version and no release for the moving tag
  ([immutable releases](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases)).
  Callers pin a full commit SHA with the version as a comment
  ([secure use](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)),
  as all four repositories already do for every action.
- **The tag namespace here.** The packages tag `@samebase/convex-hosting@0.13.1` and
  `@samebase/convex-hosting-tanstack-start@0.9.5`. The repository also holds `v0.1.3` to `v0.2.1`
  from the static-hosting history (the last from 2026-07-28). An action `v1.0.0` and `v1` would sit
  next to them: Renovate orders `v1.0.0` above `v0.2.1`, but a reader sees one `v` series with two
  meanings.

Proposed: `actions/deploy` and `actions/preview-comment` in this repository, `v1.0.0` as an
immutable release plus a moving `v1` for both, and a release only when an action changes, not with
each package release.

## Risks

- **Forks.** No secrets and a read-only token. The caller's `if` skips the job; the deploy fails
  with a message if the key is empty anyway. Never `pull_request_target`: it runs in the base
  repository's context with secrets and a write token, and checking out the pull request's head
  there is the known "pwn request"
  ([pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)).
- **Writers and the production key.** With repository secrets, anyone who can push a branch can read
  every secret from a pull request run; only the protected environment under [Secrets](#secrets)
  keeps the production key from them.
- **Permissions.** The comment needs `pull-requests: write` (or `issues: write`), and the head check
  reads the pull request. One job for both events gives the production run that permission too; two
  jobs avoid it.
- **Stale runs.** The head check refuses an old commit and a merge-commit checkout; ordering needs
  the caller's `concurrency` with `queue: max`. A caller without it can still race or lose the
  newest run, and the action cannot see that.
- **A manual run.** `workflow_dispatch` has no `head_ref`, so the deploy goes to production with
  whatever key the caller passes. The caller's triggers decide who reaches production.
- **The deployment quota.** Each branch is one Convex deployment until it expires. Today the
  previews of [#87](https://github.com/samebase/convex-hosting/pull/87) failed with
  `DeploymentQuotaReached: Your team's deployment quota of 300 has been reached`. The actions do not
  delete previews: `convex` 1.46.0 has no command for it.
- **Supply chain.** The deploy action runs with the deploy key, so callers pin it by SHA like any
  other action.

## Decisions for the maintainer

1. **Shape:** two composite actions (proposed), a reusable workflow, which alone can own the
   required `concurrency` but also owns install and takes the app's steps as strings, or
   documentation only.
2. **Where they live:** `actions/deploy` and `actions/preview-comment` in this repository (proposed;
   the examples test them on every pull request), the deploy action at this repository's root for a
   Marketplace listing, or a dedicated repository.
3. **Versioning:** `v1.0.0` releases and a moving `v1` in this repository, next to the inherited
   `v0.x` tags (proposed), or tags in a dedicated repository.
4. **The deploy flags:** from the app's `package.json` script through `node --run` (proposed), or as
   inputs (`build`, `dist`, the handling options), as #84 lists them.
5. **Preview name:** the branch as it is (proposed), `pr-<number>`, or a sanitized branch.
6. **The comment:** the marked comment action (proposed), the job's `environment` URL, or none.
7. **The production key:** a repository secret, with writers trusted, or a protected `production`
   environment limited to `main` (proposed for any repository with writers who should not hold it).
8. **Who adopts them first:** the examples, in the pull request that adds the actions (proposed),
   then ChessMerge, Scout, and Mail.

## Review

One Codex design review of `a27019f`, asked to challenge any decision and any claim about GitHub
Actions. It requested changes, with eight findings; all are folded in above:

1. A re-run of an old commit replaces the newest pending run, which then never deploys: the note
   claimed replacement only skips an intermediate commit. Now `queue: max` in the caller's group.
2. With the default merge-commit checkout, a re-run with the same head passes the head check and
   serves an older base. Now the head checkout is required and the action checks it.
3. The comment step ran before Mail's and Scout's setup, and its failure would have skipped that
   setup. Now the comment is a separate action that the caller places last.
4. The refusal of a production key with `--preview-name` exists only from CLI 0.12.0. Now the
   minimum is 0.12.0.
5. A reusable workflow can run app commands before and after the deploy in its own job; the note
   said they needed another job. Corrected, and B's real advantage, owning `concurrency`, is stated.
6. The claim that the production key reaches push runs only was too strong: a writer can change the
   workflow on a branch. Now the trust is stated, and a protected environment is decision 7.
7. A Marketplace listing does not require a dedicated repository; a root `action.yml` here is an
   option. Added to the location section and decision 2.
8. A custom token would break the comment's author match. The token input is removed.
