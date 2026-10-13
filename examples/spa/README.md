# SPA example

A Vite and React app that `@samebase/convex-hosting` serves with
`--not-found-handling single-page-application`. `public/_headers` gives the hashed files under
`/assets/` long-term caching.

- `convex/convex.config.ts` installs the component.
- `convex/http.ts` serves the site with `serveAsset`.

## Development deployment

From `examples/spa`, with `npx convex dev` running in another terminal:

```bash
pnpm run build
pnpm run upload
```

## Production

```bash
pnpm run deploy
```

The site is at `https://<deployment>.convex.site`.
