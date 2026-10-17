# AGENTS.md

A Convex component that serves a built web app (static files, and optionally server-rendered pages)
from a Convex deployment. It began as a fork of
[get-convex/static-hosting](https://github.com/get-convex/static-hosting); since 0.4 none of that
code remains.

## Layout

- `packages/convex-hosting`: the published component and CLI.
  - `src/component`: code that runs inside the component on Convex.
  - `src/client`: `routeAll`, which apps call from their `convex/http.ts`.
  - `src/cli`: the `convex-hosting` command: `deploy`, and `upload`, its inner step.
  - `src/workers-sdk`: Cloudflare's asset worker, its test cases, and its integration fixtures,
    copied from cloudflare/workers-sdk at their upstream paths by `scripts/sync-workers-sdk.ts`.
    Never edit it by hand. `pnpm run test:fixtures` runs the fixtures against local deployments.
- `packages/convex-hosting-tanstack-start`: the Vite plugin and server entry that render TanStack
  Start pages in a Convex HTTP action, and the `convex-auth` session helpers.
- `examples/tanstack-spa`: TanStack Start in SPA mode, served with the single-page-application
  fallback.
- `examples/tanstack-ssr`: TanStack Start pages rendered in a Convex HTTP action.
- `examples/tanstack-ssr-workers`: the same app as a Cloudflare Worker. Its diff from
  `examples/tanstack-ssr` is committed as `examples/tanstack-ssr-workers.patch`; after a commit that
  changes either example, run `pnpm run examples:diff` and commit the patch, or CI fails.
- `examples/hello-world-assets-only`: Cloudflare's static-site template (create-cloudflare
  `hello-world-assets-only`), one `index.html`, no build. `examples/hello-world-assets-only-workers`
  is the template as a Worker, with `examples/hello-world-assets-only-workers.patch` kept like the
  SSR pair's.

## Commands

Run from the repository root with pnpm 11 and the Node version in `.node-version`.

- `pnpm install`: install dependencies. The component's `prepare` script builds it.
- `pnpm run build`: build the packages and the examples.
- `pnpm run check`: format check, lint, typecheck, and tests. Build first: the examples typecheck
  against the built component.
- `pnpm run format`: format with oxfmt.
- `pnpm exec vp test run <path>`: run one test file.

## Conventions

- Vite+ owns formatting (oxfmt), linting (oxlint), and tests (import from `vite-plus/test`). Do not
  add ESLint, Prettier, or a separate Vitest config.
- Keep the `tsc` build for the component. Convex addresses component functions by file path, so the
  package ships one output file per source module.
- Client APIs in `src/client` use the `*Generic` types such as `GenericActionCtx`.
- Give every Convex function argument and return validators. Use `internalQuery`,
  `internalMutation`, and `internalAction` for functions that apps must not call directly; an app
  can call only a component's public functions.
- Shared dependency versions live in the `catalog` in `pnpm-workspace.yaml`.
- Releases: a version bump on `main` makes `release.yml` stage the package on npm; a maintainer
  approves it with 2FA. See `CONTRIBUTING.md`.
- An app-side script, build step, type file, or wrapper in an example or a consuming app that exists
  because a package or the adapter lacks something is a package bug. Fix it in the package in the
  same cycle; do not keep the workaround in the app.
- Never use the U+2014 em dash character. Use commas, colons, parentheses, or separate sentences.
