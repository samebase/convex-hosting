# Changelog

## 0.2.0

- `@samebase/convex-hosting-tanstack-start/server-build` declares the server entry that Vite emits.
  An app lists it in `types` in `convex/tsconfig.json` instead of writing the declaration itself.
- `@samebase/convex-hosting-tanstack-start/convex-auth` has the pieces of a Convex Auth cookie
  session: `sessionBeforeLoad` for the root route, `SessionProvider` around the document, and
  `redirectWithoutSession` with `RedirectWithoutSession` for a gate. Importing it declares Start's
  `requestContext` as `{ token: string | null }`. `@convex-dev/auth` is an optional peer dependency.

## 0.1.0

The first release: the `convexSsr()` Vite plugin and the server entry with
`fetch(request, { context })`.
