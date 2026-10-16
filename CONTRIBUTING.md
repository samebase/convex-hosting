# Contributing

You need the Node version in `.node-version` and pnpm 11. For install, deploy, and development, see
the [README](./README.md); each example's README lists its commands.

## Build and check

```sh
pnpm install
pnpm run build
pnpm run check
```

`pnpm run check` typechecks the examples against the built component, so build first.

## Component codegen

`src/component/_generated` comes from the Convex code generator, which needs a deployment. After a
change to the component's functions or schema, from `packages/convex-hosting`:

```sh
CONVEX_AGENT_MODE=anonymous npx convex dev --once
pnpm run build:codegen
```

The first command creates an anonymous local deployment and writes `.env.local`, `.convex/`, and an
empty app in `convex/`; git ignores all of them. The second runs
`npx convex codegen --component-dir ./src/component` against that deployment and builds the package.
Do not edit the generated files.

## Cloudflare's asset worker

`src/workers-sdk` is a copy of Cloudflare's asset worker and of its test cases from
cloudflare/workers-sdk, each file at its upstream path, at the commit in `src/workers-sdk/UPSTREAM`.
Do not edit it by hand: CI runs the sync and fails when the folder differs. To update it, from
`packages/convex-hosting`:

```sh
node scripts/sync-workers-sdk.ts [<commit>]
```

## Releasing

1. In a PR, bump `version` in the package's `package.json` and add a `CHANGELOG.md` entry for
   `@samebase/convex-hosting`.
2. Merge it. The `Release` workflow runs CI for that commit, stages every package version that is
   not on npm yet, and tags it as `<package name>@<version>`.
3. Approve each staged version with 2FA on npmjs.com, in the Staged Packages tab. Until then npm
   does not serve it, and later runs skip it because its tag exists.

To replace a staged version that you rejected, delete its `<package name>@<version>` tag on GitHub,
fix the problem, and merge again. The next run stages the same version from the new commit.

Before a release, test a PR build from its pkg.pr.new preview link, which CI posts on the PR.
