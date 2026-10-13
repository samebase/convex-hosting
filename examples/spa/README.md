# Convex Hosting SPA example

This example demonstrates how to use the `@samebase/convex-hosting` component to host a React/Vite
app directly on Convex.

## Running the Example

From the root of the repository:

```bash
pnpm install
cd examples/spa
pnpm run dev
```

This starts:

- The Convex backend development server
- The Vite frontend development server
- A TypeScript watcher that rebuilds the component when its source changes

## Deploying Static Files

With `CONVEX_DEPLOY_KEY` set to a production deploy key, the CLI builds with the right
`VITE_CONVEX_URL`, uploads `dist/`, pushes the backend, and then makes the new files live:

```bash
# From examples/spa
pnpm run deploy
```

Your app will then be available at `https://your-deployment.convex.site`.

## Files

- `convex/convex.config.ts` - Imports and uses the hosting component
- `convex/hosting.ts` - Exposes the deployment query for `<UpdateBanner />`
- `src/` - Example React application

## How It Works

1. The component stores static files in its own Convex file storage
2. The component's HTTP routes serve files with proper Content-Type and caching
3. Each upload is a version with its own ID; `deploy` makes it live after the backend push
