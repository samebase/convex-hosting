# Prior art: how deploy tools bind code to its static files

Read on 2026-10-17 by a research agent at these commits: workers-sdk `855812b79f`,
get-convex/static-hosting `5d9992c` (v0.2.1), convex-js `322c395` (v1.47.0), sveltejs/kit
`dd2d975484`, withastro/astro `c75e89711a`, opennextjs-cloudflare `15f4c9e5c1`. Paths are relative
to each repository; "L" is a line number. This note is the evidence for
[the version-id proposal](./2026-10-17-version-id-from-the-build.md).

## Cloudflare Wrangler, `wrangler deploy` with `assets.directory`

The asset logic lives in `packages/deploy-helpers/src/deploy/helpers/assets.ts`;
`packages/wrangler/src/assets.ts` only validates the directory (L44-115).

- Manifest: `buildAssetManifest` (L627-681) walks the directory, honors `.assetsignore`, skips
  symlinks and directories, throws above `MAX_ASSET_SIZE`, and records `{hash, size}` per normalized
  path (L673-676).
- Hash (`deploy-helpers/src/deploy/helpers/hash.ts` L5-13): BLAKE3 of the base64 of the bytes plus
  the extension, hex, first 32 characters.
- Limits (`packages/workers-shared/utils/constants.ts` L30-32): 100,000 files, 25 MiB per file; the
  [limits page](https://developers.cloudflare.com/workers/platform/limits/) says 20,000 files on
  Free.
- Upload session (assets.ts L86-98): `POST .../workers/scripts/{name}/assets-upload-session` with
  the manifest answers `{buckets, jwt}` (L42-46), `buckets` being the hashes the server lacks; an
  empty list makes that `jwt` the completion token (L117-136). The
  [direct-upload doc](https://developers.cloudflare.com/workers/static-assets/direct-upload/) says
  files uploaded in previous versions are omitted and the JWT lasts one hour.
- Upload: multipart `POST .../workers/assets/upload?base64=true` with the upload JWT (L415-445),
  parts named by hash; the last bucket's response is the completion `jwt` (L554, L580-587).
- Binding: `deploy.ts` L297-307 runs `syncAssets` before the script upload and L404-411 passes the
  `jwt` into the Worker props; `create-worker-upload-form.ts` L914-919 puts
  `metadata.assets = {jwt, config}` into the form, `config` holding `html_handling`,
  `not_found_handling`, `run_worker_first`, `_redirects`, `_headers` (L91-98). Then
  `POST .../scripts/{name}/versions` (deploy.ts L537) and a deployment (L559).
- Written into the repository: nothing. The manifest stays in memory; Wrangler writes temp bundles
  under `.wrangler/tmp` only (`workers-utils/src/wrangler-tmp-dir.ts` L18-23).
- `wrangler dev` (`packages/miniflare/src/plugins/assets/index.ts`): the manifest is built from the
  directory at start (L173-174) with `hash(filepath + mtimeMs)` as the content hash (L431-458),
  files served from disk (L360-368); a missing directory becomes an empty temp directory (L142-161).
- A path not in the manifest (`packages/workers-shared/asset-worker/src/handler.ts`): 404
  (`NoIntentResponse`, L101-108, L183-200) unless `not_found_handling` says otherwise (L1040-1071).
  A manifest hash that storage lacks throws (`asset-worker/src/worker.ts` L160-170).

## Cloudflare versions and deployments

A [version](https://developers.cloudflare.com/workers/versions-and-deployments/) holds code, static
assets, bindings, and compatibility settings; the manifest "is used to track assets associated with
each Worker version" (direct-upload doc).
[Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) deploy a
chosen version again, among the 100 most recent (raised from 10 on
[2025-09-11](https://developers.cloudflare.com/changelog/post/2025-09-11-increased-version-rollback-limit/)).
No time-based retention is stated. The
[gradual-rollouts doc](https://developers.cloudflare.com/workers/static-assets/routing/advanced/gradual-rollouts/)
describes HTML of version A requesting a hashed file only version B has, which answers 404: one
asset set per version.

## Netlify

`POST /sites/{site_id}/deploys` (`createSiteDeploy`,
[swagger.yml](https://raw.githubusercontent.com/netlify/open-api/master/swagger.yml) L1094) takes
`files` (path to SHA1), `functions` (name to SHA256), `edge_functions`, and `server` (L4895-4955).
The [guide](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/) says the
response lists `required` digests and `required_functions`; the client uploads only those
(`PUT /deploys/{id}/files/{path}` L1596, `PUT /deploys/{id}/functions/{name}` L1627); "once the
state changes to `ready`, the deploy is live". The
[deploy overview](https://docs.netlify.com/deploy/deploy-overview/): "No changes go live on your
site's public URL before all changes have been uploaded... deploys are atomic". Rollback publishes a
previous deploy; deploys are deleted after 30 days (90 on paid plans), the published one exempt
([manage deploys](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/)).

## Vercel

[`POST /v2/files`](https://vercel.com/docs/rest-api/reference/endpoints/deployments/upload-deployment-files)
uploads each file with `x-vercel-digest` (SHA1); "before you create a deployment you need to upload
the required files".
[`POST /v13/deployments`](https://vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment)
takes `files` as inline data or `{sha, size}` references. A deployment has one URL and lists its
static assets and functions together.
[Rollback](https://vercel.com/docs/deployments/rollback-production-deployment) points production at
a chosen deployment without a rebuild. [Retention](https://vercel.com/docs/deployment-retention) is
plan-based (Pro: production one year).

## get-convex/static-hosting 0.2.1

- Serving: files are rows in `staticAssets` (`src/component/schema.ts` L5-14), looked up by path
  with no deployment filter (`src/component/lib.ts` L55-75). The live set is the rows that exist;
  `deploymentInfo` (`schema.ts` L50-60) is a metadata singleton clients subscribe to for reload.
- Publish: the CLI uploads files and stages the manifest in chunks (`src/cli/upload.ts` L571, L676),
  then `lib:publishDeployment` (L687) deletes the old rows, inserts the staged rows, and sets
  `deploymentInfo` in one transaction (`lib.ts` L685-815). Limits: 1,800 files, 2 MiB manifest
  (`INTEGRATION.md` L284-294).
- Generated files in the repository: none per deploy; `setup` writes `convex/convex.config.ts` and a
  `deploy` script once (`src/cli/setup.ts` L84, L111).
- Order (`src/cli/deploy.ts` L59-63): build, `npx convex deploy`, upload. L13: "minimize the
  inconsistency window between backend and frontend". On a first deploy the backend goes first to
  read the URLs (L216-236); `MIGRATION.md` L412-414 says the component-owned root shows a setup page
  between the backend deploy and the first upload.

## Convex CLI 1.47.0

- `dev --skip-push` is a hidden option (`src/cli/dev.ts` L163) that configures the deployment and
  writes `.env.local` (`src/cli/lib/deployment.ts` L42-82, `src/cli/lib/init.ts` L20) without
  pushing (L283-304). The hidden `convex init` is "Equivalent to
  `npx convex dev --once --skip-push`" (`src/cli/init.ts` L8).
- `codegen` needs a deployment (`src/cli/codegen.ts` L78-90) and bundles all of `convex/`
  (`src/cli/lib/components.ts` L384-402, L550-553); an esbuild error ends the CLI
  (`src/bundler/index.ts` L226-236).
- Non-entry files are skipped (`_generated/`, dotfiles, `schema.ts`, names with two dots or spaces;
  `src/bundler/index.ts` L457-480), but imports from an entry must resolve. External packages exist
  only for `"use node"` bundles (`src/cli/lib/config.ts` L651-659); the default runtime bundle has
  no externals (L633-639).
- `deploy --cmd` runs before typecheck, bundle, and push (`src/cli/deploy.ts` L52-58, L332-369) and
  can only inject the deployment's two URLs (`--cmd-url-env-var-name`, `src/cli/lib/command.ts`
  L377-385; `src/cli/lib/deploy2.ts` L545-570).
- Functions read deployment variables with `process.env`
  ([docs](https://docs.convex.dev/production/environment-variables)); the docs warn not to condition
  exports on them, as they are "not reevaluated when you change an environment variable".
- No pre-push hook: `convex.json` has `functions`, `node`, `codegen`, `bundler`,
  `generateCommonJSApi`, `typescriptCompiler` (`config.ts` L327-344).

## SvelteKit, Astro, OpenNext on Cloudflare

- SvelteKit `adapter-cloudflare` (`packages/adapter-cloudflare/index.js`): the build writes the
  worker (L120), client assets and prerendered pages (L108-109), and `.assetsignore` (L191) under
  `.svelte-kit/cloudflare`; the generated worker embeds `MANIFEST_ASSETS`, the set of asset paths,
  and `PRERENDERED` (L130-131). The user commits a hand-written `wrangler.jsonc` with `main` and
  `assets.directory` pointing there
  ([docs](https://github.com/sveltejs/kit/blob/main/documentation/docs/25-build-and-deploy/60-adapter-cloudflare.md)).
  Nothing generated has to exist before the first command.
- Astro `@astrojs/cloudflare` builds on `@cloudflare/vite-plugin` and patches the generated
  `dist/server/wrangler.json` after the build (`packages/integrations/cloudflare/src/index.ts`
  L615-630); deploy is `astro build && wrangler deploy`.
- OpenNext for Cloudflare: the build writes `.open-next/worker.js` and `.open-next/assets`;
  `opennextjs-cloudflare deploy` (`src/cli/commands/deploy.ts` L41-77) populates the remote cache,
  keyed by `buildId` (`populate-cache.ts` L159-198), then runs `wrangler deploy`.

## Patterns

- One upload session with a completion token bound into the script upload, manifest in memory:
  Wrangler.
- Content-addressed deploy: a digest map, only missing digests uploaded, live when complete,
  functions included: Netlify, Vercel.
- The whole live file set swapped in one transaction, no per-request pointer: static-hosting.
- The build output carries its own file list, and the deploy command reads the output folder:
  SvelteKit adapter, OpenNext, Astro.
- A generated file in the repository that code imports: only convex-hosting today. None of the tools
  above needs one before the first command.
- A deployment variable read at call time: available on Convex; none of the tools uses it to bind a
  file set; not atomic with a push.
- Retention and rollback: Cloudflare keeps the 100 most recent versions; Netlify 30 or 90 days;
  Vercel by plan.
