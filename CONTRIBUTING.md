# Contributing

You need the Node version in `.node-version` and pnpm 11.

```sh
pnpm install
pnpm run build
pnpm run check
```

To run the SPA example against your own Convex dev deployment:

```sh
cd examples/spa
pnpm run dev
```

The SSR example has its own schema, so it needs a separate Convex project. See
[examples/tanstack-ssr/README.md](./examples/tanstack-ssr/README.md).

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

`@samebase/convex-files` is private at version `0.0.0`. Hosting's build includes its compiled
component, so it needs no separate npm release. Changes to this included code ship in hosting
releases. Its future independent versioning is described in
[its versioning contract](./packages/convex-files/README.md#versioning-and-deployment).

When changing files, run `pnpm run build` before testing the existing SPA or SSR example. To update
generated types, use the SPA example's configured development deployment:

```sh
cd examples/spa
pnpm exec convex codegen --component-dir ../../packages/convex-files/src/component
pnpm --filter @samebase/convex-hosting run build:files
pnpm exec convex codegen --component-dir ../../packages/convex-hosting/src/component
pnpm --filter @samebase/convex-hosting run build
```

The `vendor/files` directory is generated from the private package and is not edited or committed.
