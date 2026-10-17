# Static site example on Cloudflare Workers

Cloudflare's own static-site template, what `npm create cloudflare` writes for "Static site"
(`hello-world-assets-only`), deployed as a Worker with static assets: one `public/index.html`, no
build, no script. `public/` is byte-identical to
[`examples/hello-world-assets-only`](../hello-world-assets-only), the same template on Convex; the
files that differ between the two folders are what is specific to convex-hosting, and CI fails on
any other difference.

## Deploy

Cloudflare Workers Builds deploys it from this repository with the root directory
`examples/hello-world-assets-only-workers`, no build command, the deploy command `pnpm run deploy`
on `main`, and the preview command `pnpm run deploy:preview` on other branches.
[docs/workers.md](../../docs/workers.md#the-same-app-on-cloudflare-workers) lists the settings.

## Commands

- `pnpm run dev`: `wrangler dev`, the site on localhost.
- `pnpm run deploy`: `wrangler deploy`.
- `pnpm run deploy:preview`: `wrangler preview`, the Workers Builds preview command.
