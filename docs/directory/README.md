# Directory listing

The values to paste into the Convex components directory form at
https://www.convex.dev/components/submit.

| Field                              | Value                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Component Name                     | Hosting                                                                                                                                                |
| Repository URL                     | https://github.com/samebase/convex-hosting                                                                                                             |
| npm package                        | @samebase/convex-hosting                                                                                                                               |
| Live Demo URL                      | https://gallant-llama-40.convex.site                                                                                                                   |
| Category                           | Integrations                                                                                                                                           |
| Short Description (150 characters) | Static files and server-rendered pages from your backend's Convex deployment. Files follow Cloudflare Workers rules. TanStack Start adapter available. |
| Tags                               | hosting, static, ssr, tanstack, cloudflare                                                                                                             |
| Video                              | none                                                                                                                                                   |
| Logo                               | [docs/directory/logo.svg](./logo.svg)                                                                                                                  |
| Thumbnail                          | [docs/directory/thumbnail.png](./thumbnail.png) (1536 x 864)                                                                                           |

`thumbnail.html` is the source of `thumbnail.png`; its first comment has the render command.

## Why these values

- Name: directory names are capability nouns, and "Hosting" matches `components.hosting`, the
  repository, and the package. The Cloudflare Workers relationship goes into the tagline and the
  description, not the name, because in the directory "Worker" means a job runner, next to Convex's
  Workpool and Batch Worker.
- Repository URL: the repository root, because the package folder has no tracked README. The
  package's `prepack` script copies the root README into the package.
- Thumbnail tagline: "Frontend and backend, one deployment. Built like a Cloudflare Worker." The
  benefit comes first, Cloudflare is the trust line, and portability is the evidence. It comes from
  a Codex review and two cold-reader tests on 2026-10-17.

## Announcement

Post this on Discord once the listing is live, with the listing URL in place of `<listing link>`.

```text
I made a component that hosts a web app on the Convex deployment that runs its backend: static files and server-rendered pages, at your `convex.site` URL. One deployment, one URL, one command: `npx convex-hosting deploy`.

The files follow Cloudflare Workers rules. The serving code is Cloudflare's asset Worker, copied at a pinned commit, so `_headers`, `_redirects`, `html_handling` and `not_found_handling` work as on Cloudflare, and CI runs Cloudflare's own asset tests against it. Pages come from a `fetch(request)` handler, the same shape as a Worker; a TanStack Start adapter does streaming, server functions, middleware and cookie sessions. The example app deploys from the same code as a real Worker, with the diff committed.

Limits: Convex's runtime is not workerd, so no edge cache, no WebSockets, one region. The differences are documented. Before 1.0.

<listing link>
https://github.com/samebase/convex-hosting
https://gallant-llama-40.convex.site
```
