# Convex Hosting

Host a web app on Convex, next to its backend: static React and Vite apps, and server-rendered
TanStack Start pages. The site is live at `https://<deployment>.convex.site`, with no separate
hosting provider.

| Package                                                                               | What it does                                                                  |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`@samebase/convex-hosting`](./packages/convex-hosting)                               | The Convex component, and the `convex-hosting` CLI that uploads the built app |
| [`@samebase/convex-hosting-tanstack-start`](./packages/convex-hosting-tanstack-start) | The Vite plugin and server entry that render TanStack Start pages in Convex   |

The component keeps one live version of the site per deployment and serves it with the code of
Cloudflare's Workers Static Assets handler, so routing modes (SPA or 404 page), `_headers`,
`_redirects`, `.assetsignore`, and a one-year cache for hashed files work as on Cloudflare.
`convex-hosting deploy` builds the app, uploads it as a new version, pushes the backend, makes the
version live, and verifies it. The [package README](./packages/convex-hosting/README.md) describes
the setup, the first-install order, and the limits.

Examples: [`examples/spa`](./examples/spa) (Vite and React) and
[`examples/tanstack-ssr`](./examples/tanstack-ssr) (TanStack Start pages rendered in a Convex HTTP
action).

This is Samebase's fork of [get-convex/static-hosting](https://github.com/get-convex/static-hosting)
(Apache-2.0, see [NOTICE](./NOTICE)). It is not affiliated with or endorsed by Convex.

To work on this repository, see [CONTRIBUTING.md](./CONTRIBUTING.md).
