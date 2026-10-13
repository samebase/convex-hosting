# Convex Hosting SPA example

A Vite and React page that the `@samebase/convex-hosting` component serves from a Convex deployment.
The counter shows that the served script runs.

- `convex/convex.config.ts` installs the component and mounts its HTTP route at `/`.
- `src/` is the page.

## Run

From the root of the repository:

```bash
pnpm install
cd examples/spa
pnpm run dev
```

This starts the Convex development backend, the Vite development server, and a TypeScript watcher
that rebuilds the component when its source changes.

## Upload and deploy

To serve a build from the development deployment, at `https://<deployment>.convex.site`:

```bash
pnpm run build && pnpm run upload
```

With `CONVEX_DEPLOY_KEY` set to a production deploy key, `pnpm run deploy` builds, uploads `dist/`
as a new version before the backend push, makes the version live after it, and checks that
`/index.html` is the new one. The first deploy to a deployment pushes the backend first, so the site
answers 404 until the upload ends.
