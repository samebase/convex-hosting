# SPA example

A Vite and React app that `@samebase/convex-hosting` serves with
`--not-found-handling single-page-application`: `convex/http.ts` serves it with `serveAsset`, and
`public/_headers` caches the hashed files under `/assets/` for a year.

From `examples/spa`:

- `pnpm run build`: build the site into `dist`.
- `pnpm run upload`: upload `dist` to the development deployment that `npx convex dev` pushes.
- `pnpm run deploy`: build, upload, and push to production.

For the order of the first start and everything else, see the [README](../../README.md).
