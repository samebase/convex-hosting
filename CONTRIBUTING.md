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

## Documentation

The root `README.md` is the documentation of `@samebase/convex-hosting`. The package's `prepack`
script copies it into `packages/convex-hosting`, so npm shows the same text. Edit only the root
README, and use absolute GitHub links in it: relative links break on npm.

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
