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
[examples/ssr/README.md](./examples/ssr/README.md).
