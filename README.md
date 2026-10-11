# Convex Hosting

Host a web app on Convex, next to its backend: static React and Vite apps, and server-rendered
TanStack Start pages. The site is live at `https://<deployment>.convex.site`, with no separate
hosting provider.

| Package                                                                               | What it does                                                                  |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`@samebase/convex-hosting`](./packages/convex-hosting)                               | The Convex component, and the `convex-hosting` CLI that uploads the built app |
| [`@samebase/convex-hosting-tanstack-start`](./packages/convex-hosting-tanstack-start) | The Vite plugin and server entry that render TanStack Start pages in Convex   |

Examples: [`examples/spa`](./examples/spa) (Vite and React) and
[`examples/tanstack-ssr`](./examples/tanstack-ssr) (TanStack Start pages rendered in a Convex HTTP
action).

This is Samebase's fork of [get-convex/static-hosting](https://github.com/get-convex/static-hosting)
(Apache-2.0, see [NOTICE](./NOTICE)). It is not affiliated with or endorsed by Convex.

To work on this repository, see [CONTRIBUTING.md](./CONTRIBUTING.md).
