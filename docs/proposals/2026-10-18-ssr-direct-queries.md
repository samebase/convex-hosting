# Proposal: direct Convex queries during SSR

Status: not approved, 2026-10-18. Written by an AI assistant from the code at `16bbf82` and two
measured prototypes on the example's development deployment, then revised after one Codex design
review (the last section). Nothing is implemented. The decisions that only the maintainer can make
are listed at the end.

## The problem

On Convex, a server-rendered page that reads data calls its own deployment over HTTPS. The render
runs inside the deployment's HTTP action, which already holds `ctx.runQuery`, but the data goes
through `ConvexHttpClient`, the client that a Cloudflare Worker needs.

The path, as the code has it:

1. `serveSite` in `packages/convex-hosting/src/client/index.ts` (lines 26 to 41) answers files, then
   calls `worker.fetch(request)`. The worker gets the request and nothing else.
2. The app's `src/server.ts` reads the session cookie and calls the adapter's server entry with
   `context: { token }`.
3. Start calls the app's `getRouter()` for the request. `new ConvexQueryClient(url)` creates, on the
   server, `serverHttpClient = new ConvexHttpClient(url)` (`@convex-dev/react-query` 0.1.0,
   `src/index.ts` line 177).
4. `sessionBeforeLoad` calls `serverHttpClient.setAuth(token)` when there is a token.
5. Each loader query and each `useSuspenseQuery` on the server goes to `queryFn`, which calls
   `serverHttpClient.consistentQuery(func, args)` (line 360). The first call posts to
   `/api/query_ts`, waits for the timestamp, then posts to `/api/query_at_ts`; later queries of the
   same render reuse the timestamp (`convex` 1.46.0, `src/browser/http_client.ts` lines 229 to 260
   and 322). Both endpoints are undocumented; the [HTTP API](https://docs.convex.dev/http-api/)
   documents only `/api/query`, `/api/mutation`, `/api/action`, and `/api/run`.

So the first query of every page costs two sequential round trips from the deployment to itself.

## Measurements

An instrumented copy of `16bbf82` ran on the example's development deployment (`next-monitor-57`),
from a scratch worktree, not committed; the deployment was put back to `main` afterwards. Each
response carried `Server-Timing` entries: every HTTPS call to the deployment, every query, the
render (the adapter's `fetch` until the response headers), and the route query of `serveSite`. 30
sequential requests per URL, the URLs alternated, a browser User-Agent, two warm-up rounds, from a
machine about 160 ms from the deployment. Values are p50.

| Page                     | Data path                 | Data reads                                    | Server render | Client, headers |
| ------------------------ | ------------------------- | --------------------------------------------- | ------------- | --------------- |
| `/`                      | HTTPS, consistent (today) | 26.9 ms (`query_ts` 13.1, `query_at_ts` 12.9) | 35.8 ms       | 185.9 ms        |
| `/`                      | HTTPS, inconsistent       | 13.9 ms (`/api/query`)                        | 23.2 ms       | 178.7 ms        |
| `/`                      | `ctx.runQuery`            | 1.2 ms                                        | 9.1 ms        | 163.7 ms        |
| two queries, in parallel | HTTPS, consistent         | 28.6 and 29.2 ms                              | 39.2 ms       | 194.4 ms        |
| two queries, in parallel | HTTPS, inconsistent       | 14.2 and 14.4 ms                              | 23.9 ms       | 178.0 ms        |
| two queries, in parallel | `ctx.runQuery`            | 1.7 and 1.8 ms                                | 9.2 ms        | 162.7 ms        |
| `/signin`                | no data                   | none                                          | 6.3 ms        | 160.8 ms        |

The "two queries" page was a temporary route that loads `todos.latest` and `users.me` (which answers
`null` without a session) with `Promise.all`. A second run with the automatic wiring of candidate
(ii) below gave the same picture: `/` 37.1 ms against 8.7 ms of server render, data reads 28.5 ms
against 1.5 ms. The live production site, measured from outside only: `/` 199 ms, `/signin` 180 ms,
`/about/` (a file) 201 ms, p50 of 15.

What the numbers say:

- One HTTPS round trip from the action to its own deployment takes 13 to 14 ms. Today's consistent
  mode pays two in sequence: 27 ms, three quarters of the 36 ms that `/` takes to render. A page
  without data renders in 6.3 ms.
- `ctx.runQuery` takes 1.2 to 1.8 ms per query. With it, `/` renders in 3 ms more than `/signin`.
- Queries in parallel share the timestamp, so the second one adds almost nothing. Each sequential
  dependency between queries adds a round trip.
- The 27 ms come from two changes. The inconsistent option alone removes one round trip (reads 26.9
  to 13.9 ms, render 35.8 to 23.2 ms), on both hosts and for signed-in renders too. The direct path
  removes the other one (reads 13.9 to 1.2 ms, render 23.2 to 9.1 ms), on Convex only. Both give up
  the shared snapshot; the direct path gives up nothing more.
- The visitor gets the first byte 23 to 30 ms sooner. From 160 ms away that is 15%; for a visitor
  near the deployment it is most of the server time.
- Signed-in renders were not measured: that needs a session, and no account was created on a cloud
  deployment. Their queries take the same two round trips, with a `Bearer` token.

Two runtime facts, measured in the same prototype:

- A query that starts 500 ms after the loader returned, so after the shell went out and the HTTP
  action's handler returned its `Response`, ran through `ctx.runQuery` in 1.8 ms. The `ctx` stays
  usable while the body streams.
- A page request with `Authorization: Bearer not-a-jwt`: `ctx.auth.getUserIdentity()` in the site's
  action threw "Could not parse JWT payload". The HTTPS path rendered the page with 200, because it
  never forwards the header. The site action's identity is whatever the request's `Authorization`
  header carries.

## What Convex offers inside an HTTP action

- `ctx.runQuery(query, args)` runs a public or internal query by reference
  ([`GenericActionCtx`](https://docs.convex.dev/api/interfaces/server.GenericActionCtx);
  `convex/src/server/registration.ts` line 340). In actions it takes no options; `transactionLimits`
  exists for queries and mutations, `useStaleSnapshot` for mutations only. The JavaScript side sends
  the function's address, the arguments, and the request id (`src/server/impl/actions_impl.ts` lines
  28 to 38).
- "Each `runQuery` call is a separate read transaction" (the JSDoc), and "Multiple runQuery /
  runMutations execute in separate transactions and aren't guaranteed to be consistent with each
  other" ([actions](https://docs.convex.dev/functions/actions)).
- Limits: 1000 concurrent IO operations per function, 64 MiB of memory, 30 minutes of execution in
  the Convex runtime ([limits](https://docs.convex.dev/production/state/limits)). No limit on the
  number of `runQuery` calls.
- `AsyncLocalStorage` is in the Convex runtime since `convex` 1.39.0, and "stored values will not be
  threaded through calls to `ctx.runQuery`" (changelog). TanStack Start already runs every render in
  its own `AsyncLocalStorage` on Convex.
- Nothing at runtime tells a public query from an internal one. The generated `api` object is a
  Proxy that builds a reference for any name, and the deployment knows each function's visibility
  (`npx convex function-spec` reports it) but a running function cannot ask. The HTTPS endpoints
  refuse internal functions; `ctx.runQuery` runs them.
- Every function sees its own deployment's URL as `CONVEX_CLOUD_URL`
  ([system environment variables](https://docs.convex.dev/production/environment-variables)).
- References resolve across copies of the `convex` package: the function name sits on
  `Symbol.for("functionName")` (`src/server/functionName.ts`), so the render bundle's `api` works
  with the action bundle's `ctx`. The prototype relied on this.
- `ConvexQueryClient.serverHttpClient` is a public, mutable field (line 142), read at each query
  (lines 358 to 371). `ConvexHttpClient`'s `query`, `consistentQuery`, `action`, and `setAuth` are
  public. A per-request swap of the transport needs no fork.

## Auth: who the direct query is

A direct query runs as the HTTP action that calls it. The nested query runs with the action's own
identity: in the backend, `async_syscall_actions_runQuery` passes `self.identity` through
`propagate_component_auth`, and its arguments (`name`, `reference`, `function_handle`, `args`) have
no identity field
([`crates/isolate/src/environment/action/async_syscall.rs`](https://github.com/get-convex/convex-backend/blob/main/crates/isolate/src/environment/action/async_syscall.rs)).
An HTTP action's identity comes from the request's `Authorization` header
([functions auth](https://docs.convex.dev/auth/functions-auth), and the measurement above). A
browser navigation never carries that header, only the Convex Auth cookie. So for every browser
render, the site action has no identity, and neither does a query it runs.

Nothing today runs a query as the identity of a token that the action holds:

- `GenericActionCtx.runQuery(query, args)`: no identity, no options.
- `ctx.meta.getRequestMetadata().authToken` (`convex` 1.42.2) reads the request's own token; it sets
  nothing.
- Convex Auth 2.0.0-alpha.2's server helpers only decode the access token (`decodeAccessToken`:
  "they never verify the signature (Convex verifies it against the JWKS)") or verify it over HTTPS
  (`createServerAuthChecker` asks the backend).
- `ConvexHttpClient.setAdminAuth(adminKey, actingAsIdentity)` acts as a user only with an admin key,
  over HTTPS: a deploy key inside every render, and still the network.
- `convex` 1.47.0 (2026-10-15) adds `ctx.meta.getSnapshotTs()` and `getServiceUrl`; nothing about
  identity.

So, what is possible today:

1. **Direct for renders without identity, HTTPS with the token for the rest.** Safe by construction
   when the direct path runs only if the client holds no credentials and
   `ctx.auth.getUserIdentity()` resolves to `null` (it threw on a malformed token in the
   measurement; any throw counts as "not anonymous"): both paths then run the query with no
   identity. Signed-in renders keep today's cost.
2. **Internal queries that take a verified user id.** The action would verify the access token
   itself against `AUTH_JWKS` (signature, `iss`, `aud`, `exp`), which re-implements a security check
   that Convex owns, and every authenticated query would get a second, server-only twin whose result
   must be stored under the public query's key so that the browser hydrates it. The app's code shape
   doubles. Not recommended.
3. **One authenticated self-request per signed-in render.** The site action forwards the render to
   its own site URL with `Authorization: Bearer <token>`; Convex verifies the token at that action's
   entry, and every query inside it goes direct with the user's identity. No deploy key and no
   duplicate queries, but one round trip remains (13 ms), the same count as inconsistent HTTPS with
   parallel loaders, plus a second action per page and the request and streamed response proxied
   through the first. It pays only for pages whose queries depend on each other in sequence. Not
   measured; not recommended now.

What would need Convex, for signed-in reads with no round trip: a way to run a query as a token's
identity, verified the way an HTTPS call is verified against `auth.config.ts`, for example
`ctx.runQuery(ref, args, { auth: token })`, or HTTP actions that take their identity from a
configured cookie. With that, the direct path covers signed-in renders and nothing else in this
proposal changes.

## Consistency and hydration

`consistentQuery` pins one timestamp for the render. `ctx.runQuery` cannot: each call is its own
transaction at the latest timestamp, and no action API reads at a given timestamp. The direct path
therefore has the semantics of `dangerouslyUseInconsistentQueriesDuringSSR: true`, the official
option whose own documentation names the risk: two queries of one page can come from different
snapshots, which matters for client-side joins.

Hydration is not affected either way. TanStack dehydrates each query's result into the page and the
browser hydrates from it, so the first browser render matches the HTML; the subscription then
replaces the values with live ones. Consistency decides only whether two results in one HTML page
agree with each other.

One snapshot is still possible on the direct path, through the app's data shape rather than the
transport. A query runs in one transaction: the queries it calls with nested `ctx.runQuery`, and a
second read whose arguments it derives from the first, share its snapshot. A page that loads its
related data through one such query gets a consistent result, directly. What cannot share a snapshot
is independent queries from the action, which is what TanStack loaders and components issue.

## Candidates for the transport

- **(a) Swap `serverHttpClient` for a `ConvexHttpClient` subclass** whose `query` calls
  `ctx.runQuery(func, args)` when the gates below hold, and `super` otherwise. `consistentQuery` is
  not overridden: the integration calls `query` only when the app chose inconsistent server reads
  (line 362), so the consistent default and any explicit `consistentQuery` keep their snapshot over
  HTTPS. The subclass overrides `setAuth`, `setAdminAuth`, and `clearAuth` to know its current
  credentials, and decides on every call. Public field, public methods, no wire format. A future
  `@convex-dev/react-query` that calls another method reaches `super`, today's HTTPS path, so a
  mismatch fails slow, not wrong. Both prototypes measured this transport (they also overrode
  `consistentQuery`, changed after the review).
- **(b) A `fetch` that answers `/api/query*` in-process**, through the client's `{ fetch }` option
  or a patched global `fetch`. It emulates the undocumented `query_ts` and `query_at_ts` endpoints
  and the `convex_encoded_json` format, converts every value to JSON and back, and a global patch
  also sees the core's storage fetches. Rejected for (a).
- **(c) Keep HTTPS and make it cheaper.** `dangerouslyUseInconsistentQueriesDuringSSR: true` drops
  `query_ts`: 27 to 14 ms, one line in `getRouter`, on both hosts, signed-in renders included.
  Connection reuse is not in reach of JavaScript, and the two sequential calls each take the same 13
  ms, so there is no visible setup cost to save. The HTTP API has no batch endpoint.
- **(d) Runtime limits** do not block (a): the measured facts and the limits above.

### The gates, and what they cannot keep

A query goes direct only when all four hold; otherwise it goes over HTTPS as today.

1. **Method.** `query`, which the integration calls when the app chose inconsistent server reads.
2. **Credentials.** The client holds none: nothing was set through it since it was installed, and it
   is installed where the adapter sets the token today (`sessionBeforeLoad`), before other route
   code runs. A server client that app code authenticates somewhere else is outside this contract.
3. **Identity.** `ctx.auth.getUserIdentity()` resolves to `null`; a throw counts as not anonymous.
4. **Target.** The client's URL equals the deployment's `CONVEX_CLOUD_URL`. A site whose data lives
   on another deployment, or that reaches its own through a custom domain, keeps HTTPS.

Under these, identity, consistency, and the target are the same on both paths. **Visibility is
not.** The HTTPS path refuses internal functions; `ctx.runQuery` runs them, and nothing at runtime
can tell them apart. If an app builds a reference from visitor input (a generic `/q/$name` route,
say), the HTTPS path answers an error and the direct path renders an internal query's result into
anonymous HTML. No enforcement is available today: an allowlist from `npx convex function-spec`
reads the deployed functions, so it is one push behind and brings back a generated file that must
exist before the first push; and `ctx.runQuery` has no option that applies the public check.

## Candidates for the interface

Each needs `ctx` to reach the render. The worker is the app's `src/server.ts`, which wraps the
adapter's entry and passes its own `context`, so whatever the core gives the worker passes through
app code first.

**(i) Explicit.** The core calls `worker.fetch(request, ctx)`. The app's `src/server.ts` takes the
second argument and passes it on as `context: { token, convex: ctx }`; `sessionBeforeLoad` installs
the direct client when `serverContext.convex` is there.

- Core: about 3 lines. Adapter: the subclass and the install, about 45. Example: 2 lines in
  `src/server.ts`.
- The Worker: Cloudflare's second argument is `env`, so the twin's `src/server.ts` cannot take the
  same line, and the patch grows by those lines.
- Against the repository's rule that an app-side line which exists because the package lacks
  something is a package bug. Measured in the first prototype.

**(ii) Automatic.** When `convex/http.ts` turns it on with one option on `routeAll` (a Convex-only
file, so the twin does not change; the reason for an option is the visibility boundary above), the
core runs `worker.fetch(request)` inside an `AsyncLocalStorage` that it exports from a subpath (the
prototype used `@samebase/convex-hosting/request`). `convexSsr()` keeps `@samebase/convex-hosting`
external in the server build (`ssr.external`, which takes priority over `noExternal: true`), so
Convex's bundler resolves the server build's import and `convex/http.ts`'s to one module and one
store. The adapter's server entry reads the store and adds the request's direct client to the
context it gives Start; `sessionBeforeLoad` installs it as `serverHttpClient`.

- Core: the subpath (about 6 lines), the option and `actionCtx.run(ctx, ...)` in `serveSite`, the
  export and its declaration. Adapter: `ssr.external`, about 8 lines in the server entry, the
  subclass (about 45 with the four gates, the credential overrides, the fallback, and the error
  rethrow below), 4 in `sessionBeforeLoad`, and one optional field in `RequestContext`. Apps: the
  option in `convex/http.ts`; the patch is unchanged.
- The Worker, Vite's dev server, and the build's prerender have no store, so they use HTTPS. The
  twin never imports the adapter's server entry.
- Measured in the second prototype: the import stayed external in `dist/server/server.js`, the
  prerender resolved it in Node, the store reached the render on Convex, and the numbers matched the
  first prototype.
- Risks: if two copies of `@samebase/convex-hosting` ever resolve, the store is empty and pages
  render over HTTPS, correct but slow and silent; a check on the example deployment should assert
  the direct path. An app without Convex Auth has no `sessionBeforeLoad` and gets nothing until the
  adapter has a root `beforeLoad` for it, an export the design adds only when an app needs it. The
  `convex-auth` entry, documented as host-neutral, gains one host-specific line that is inert on
  other hosts.
- An alternative channel between the two bundles is a global keyed by `Symbol.for(...)`: no build
  setting, but a hidden global. The externalized module is the same idea with the bundler's module
  identity, and it is proven.

**(iii) A documented app pattern.** An app cannot reach `ctx` at all, because `routeAll` owns the
action, so this still needs the core change of (i), and every app copies the subclass and the
install. Rejected by the same repository rule.

Risks that hold for every interface:

- Visibility, above: the gates cannot keep it.
- An error from `ctx.runQuery` is a `ConvexError` of the action bundle's copy of `convex`;
  `instanceof ConvexError` in render code tests the render bundle's copy. The subclass rethrows with
  the render bundle's class.
- If the request context carries the raw `ctx`, loaders can call `runMutation`, internal functions,
  and the scheduler on Convex and break on a Worker. Carrying only the direct client keeps the
  app-visible API a `ConvexHttpClient` on both hosts.

## Recommendation

Candidate (ii) with transport (a) and the four gates, off by default and turned on by one option in
`convex/http.ts`. Under the gates, a direct query runs with the same identity, consistency, and
target as the HTTPS query it replaces, and the measured gain over HTTPS with the same consistency is
reads 13.9 to 1.2 ms and render 23.2 to 9.1 ms on anonymous renders; the Worker twin and the app's
`src` do not change. The option exists because visibility is the one thing the gates cannot keep:
turning it on states that the render builds references only from `api`, never from input.

The inconsistent option is a separate choice, on both hosts: it saves 13 ms by itself, signed-in
renders included, and it is what makes the direct path run. If server reads must stay consistent,
the transport does not apply; a page that needs one snapshot loads its related data through one
query, which then runs direct in one transaction. Signed-in renders get no direct path until Convex
can run a query as a verified token.

Ask Convex for two `ctx.runQuery` options, the public-visibility check and a verified token's
identity. With both, the option and the credentials gate can go, and signed-in renders go direct.

## Decisions for the maintainer

1. **Consistency.** Do the examples switch to `dangerouslyUseInconsistentQueriesDuringSSR: true`
   (one line in both `router.tsx`, the patch unchanged)? It saves 13 ms on both hosts by itself;
   without it, the direct path never runs.
2. **Visibility and the default.** Off by default, on with one option in `convex/http.ts` that
   states the render builds references only from `api` (recommended); or on by default, which
   silently lets every app's render reach internal queries; or nothing until Convex has a public
   check.
3. **Ask Convex** for `ctx.runQuery` with the public check and with a verified token's identity?
   (Recommended; either one removes a gate.)
4. **Interface.** Automatic (ii), recommended, or explicit (i), with two lines in every app's
   `src/server.ts` and a larger patch?
5. **Channel between the bundles** for (ii): the externalized subpath (recommended, measured) or a
   `Symbol.for` global.
6. **What the request context carries**: the request's direct client (recommended) or the raw `ctx`,
   which gives loaders Convex-only powers.
7. **Auth policy**: direct only without credentials and identity (recommended); one authenticated
   self-request per signed-in render (not now); app-verified tokens with internal queries (not
   recommended).
8. **Worker parity**: the direct path makes Convex's data reads faster than the twin's, which
   already pays an internet round trip from the edge. Accept, and state it in `docs/workers.md`?
9. **Scope**: queries only (recommended). The session refresh in `src/server.ts`
   (`convex.mutation(api.auth.refreshSession, ...)`, an HTTPS mutation on every page request that
   comes 50 seconds or more after the last refresh), server functions, and the `/auth` routes keep
   HTTPS for now.

## Review

One Codex design review of `2d0454f`, the first version of this note, asked to challenge any
decision and any claim about Convex's runtime or auth. From the installed SDK and the backend
source, it confirmed the streaming lifetime, the inherited action identity, the separate
transactions, and the limits. It did not rerun the prototypes, so the measurements rest on this
note's own runs. The revised version has not been reviewed again.

Taken, and what changed:

1. **P1, visibility.** The first version called a reference built from input "a bug on either path".
   The HTTPS path refuses internal functions and the direct path does not, so the direct path widens
   what an anonymous page can show. It is now a named boundary, and the recommendation went from on
   by default to an option in `convex/http.ts`, plus a request to Convex.
2. **P1, target.** The gates did not require the client to point at this deployment; a client on
   another deployment would have rendered this one's data. Gate 4 added.
3. **P2, credentials.** The render's token is not the client's credentials: a client authenticated
   before the swap, or by a later `setAuth`, was not covered. The subclass now tracks `setAuth`,
   `setAdminAuth`, and `clearAuth` and decides on every call; the install point is a stated
   contract.
4. **P2, explicit `consistentQuery`.** Overriding it would have dropped a snapshot that an app asked
   for. Only `query` is overridden now, which also turns the consistency gate into structure.
5. **P2, consistent direct reads.** A query that derives its second read from its first shares one
   snapshot. "Consistent reads need HTTPS today" was wrong and is replaced by the data-shape route.
6. **P2, signed-in reads without a new API.** One authenticated self-request per render is a third
   option, now listed with its cost; not recommended now.
7. **P2, attribution.** Against HTTPS with the same consistency, the direct path saves 13.9 to 1.2
   ms of reads; the 27 ms figure needs the inconsistent option too. The measurements and the
   recommendation now separate the two.

Not taken: the remedy that objection 1 proposed, an enforceable public-function allowlist before the
swap is enabled. Nothing can enforce it at runtime today, and a list from `npx convex function-spec`
is one push behind and brings back a generated file that must exist before the first push, the
problem the first-run study removed. The note offers an explicit opt-in and a Convex request
instead; the objection itself stands, and decision 2 is where it lands.

Corrected in the same revision, found on a re-read: which `runQuery` options exist where, and that
the measured `getUserIdentity` throw was for a malformed token.
