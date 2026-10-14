# Changelog

## 0.4.1

- `convex-hosting init` writes `.convex-hosting/version.js` with no site version when it is absent,
  so `npx convex dev` can bundle `convex/http.ts` on a fresh clone. Run it before `npx convex dev`,
  for example as a `predev` script.
- The README has numbered setup steps, rules, and a section on deploy tools and CI: tools that run
  `convex deploy` themselves, the permissions of a scoped deploy key, and where release checks go.
  It also says how to test a deep link as a browser opens it.

## 0.4.0

A new install. 0.4 does not read the data of 0.3.x and has no migration: delete the tables of the
old component by hand, then set up the app as the README says.

- One command, `convex-hosting deploy`, for production, a preview (`--preview-name <name>`), and the
  development deployment (`--dev`). The push switches the site.
- Cloudflare's asset handler serves the files, with `_headers`, `_redirects`, `.assetsignore`,
  `html_handling`, and `not_found_handling`.
- The first request that new code serves marks its version live and deletes the versions live before
  it. A version that never becomes live is deleted when it is a day old.

Earlier versions: see the [release history](https://github.com/samebase/convex-hosting/releases).
