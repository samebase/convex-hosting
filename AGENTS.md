# AGENTS.md

A Convex component that serves a built web app (static files, and optionally server-rendered pages)
from a Convex deployment. It started as a fork of
[get-convex/static-hosting](https://github.com/get-convex/static-hosting) and now goes its own way.
Changes offered back to upstream live on branches in
[samebase/static-hosting](https://github.com/samebase/static-hosting).

## Layout

- `packages/convex-hosting`: the published component and CLI.
  - `src/component`: code that runs inside the component on Convex.
  - `src/client`: the API that apps import (`registerStaticRoutes`, `serveStaticAsset`, and more).
  - `src/cli`: the `convex-hosting` command.
  - `src/react`: `UpdateBanner` and `useDeploymentUpdates`.
- `packages/convex-hosting-tanstack-start`: the Vite plugin and server entry that render TanStack
  Start pages in a Convex HTTP action.
- `packages/convex-files`: a private component that maps unique paths to native storage files.
- `examples/spa`: a Vite and React app that the component serves.
- `examples/tanstack-ssr`: TanStack Start pages rendered in a Convex HTTP action.

## Commands

Run from the repository root with pnpm 11 and the Node version in `.node-version`.

- `pnpm install`: install dependencies. The component's `prepare` script builds it.
- `pnpm run build`: build the packages and examples.
- `pnpm run check`: format check, lint, typecheck, and tests. Build first: the examples typecheck
  against the built component.
- `pnpm run format`: format with oxfmt.
- `pnpm exec vp test run <path>`: run one test file.

## Conventions

- Vite+ owns formatting (oxfmt), linting (oxlint), and tests (import from `vite-plus/test`). Do not
  add ESLint, Prettier, or a separate Vitest config.
- Keep the `tsc` build for the component. Convex addresses component functions by file path, so the
  package ships one output file per source module.
- Functions in `src/component` are internal to the component. Client APIs in `src/client` use the
  `*Generic` helpers such as `httpActionGeneric` and `internalMutationGeneric`.
- Give every Convex function argument and return validators. Use `internalQuery`,
  `internalMutation`, and `internalAction` for functions that apps must not call directly.
- Shared dependency versions live in the `catalog` in `pnpm-workspace.yaml`.
- Releases: a version bump on `main` makes `release.yml` stage the package on npm; a maintainer
  approves it with 2FA. See `CONTRIBUTING.md`.
- Never use the U+2014 em dash character. Use commas, colons, parentheses, or separate sentences.
