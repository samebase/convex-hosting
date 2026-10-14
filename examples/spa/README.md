# SPA example

A Vite and React app that `@samebase/convex-hosting` serves with
`--not-found-handling single-page-application`: `convex/http.ts` serves it with `serveAsset`, and
`public/_headers` caches the hashed files under `/assets/` for a year.

From `examples/spa`:

- `pnpm run dev`: Vite's dev server, with `npx convex dev` in another terminal.
- `pnpm run build`: build the site into `dist`.
- `pnpm run deploy:dev`: build, upload, and push to the development deployment.
- `pnpm run deploy`: build, upload, and push to production.

For everything else, see the [README](../../README.md).
