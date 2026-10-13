# Component function contract for convex-hosting 0.4.0 (version 2)

Version 2 changes, after the fourth Codex review: routing runs inside one component query
(`lib:route`); `resolveMany` and `resolve` are gone; `recordFile` returns a result instead of
throwing; `startVersion` tolerates a `ready` version; `activate` records whether a code push came
before it; smaller limits. Everything else is as before.

The CLI calls the internal functions through `npx convex run --component <name> <function>` with
JSON arguments, as today's CLI does. All functions live in
`packages/convex-hosting/src/component/lib.ts` and declare `args` and `returns` validators.

## Limits

- At most 4,000 entries per version; a path at most 1,024 bytes; a file at most 25 MiB.
- `config` JSON at most 256 KiB (Convex documents stop at 1 MiB; the asset worker's parser limits
  alone do not keep a config below that).
- With these limits every array fits in one Convex value. `finishVersion` reads a version in batches
  of 500 entries, so its immutable checks stay within the read limits of one query.

## Manifest file (uploaded by the CLI to component storage before `startVersion`)

```json
{
  "versionId": "v_abcdefghijklmnopqrstuvwxyz",
  "config": {
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none",
    "base_path": "/",
    "compatibility_date": "2025-04-01",
    "headers": { "version": 2, "rules": {} },
    "redirects": { "version": 1, "staticRules": {}, "rules": {} }
  },
  "entries": [
    {
      "path": "/index.html",
      "sha256": "<64 hex>",
      "size": 1234,
      "contentType": "text/html; charset=utf-8",
      "immutable": false
    }
  ]
}
```

- `versionId`: `v_` plus 26 lowercase base32 characters (`[a-z2-7]`), made by the CLI before the
  build.
- `config`: the asset worker's `AssetConfig` (`src/workers-shared/utils/types.ts`), normalized by
  the CLI with the vendored parsers, with `compatibility_date` at or after `2025-04-01` (navigation
  detection). The component stores it as a JSON string and re-checks the rule counts and the byte
  limit.
- `entries`: paths start with `/`, are decoded and unique; `size` is the byte length; `immutable` is
  the CLI's classification.

## Functions

| Function                | Kind                                                            | Args                                                                                                   | Returns                                                                                                                                                                             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib:generateUploadUrl` | internalMutation                                                | `{}`                                                                                                   | `string`                                                                                                                                                                            | A storage upload URL, for the manifest and for each file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lib:startVersion`      | internalAction                                                  | `{ versionId: string, manifestStorageId: string }`                                                     | `{ state: "uploading" \| "ready", pending: { path: string, sha256: string }[] }`                                                                                                    | Reads and validates the manifest; deletes the manifest object when done. Creates the `versions` row (`state: "uploading"`, `config`, `manifestSha256` = sha256 of the manifest bytes, `entryCount`, `createdAt`). Writes entries in batches of at most 500 per mutation, skipping paths that already exist for that version, so a repeat continues. Returns the entries without a `storageId`. For an existing version with the same digest: `uploading` continues; `ready` returns `{ state: "ready", pending: [] }`. Fails for a different digest, for `deleting`, and when an `immutable` entry has a different `sha256` than an entry at the same path in another `ready` version. |
| `lib:recordFile`        | internalMutation                                                | `{ versionId: string, path: string, storageId: string }`                                               | `{ ok: true } \| { ok: false, reason: string }`                                                                                                                                     | Requires `uploading`. Reads `ctx.db.system.get(storageId)`; when its `sha256` and `size` equal the entry's, sets `storageId` and returns `ok: true`. On a mismatch, deletes the object and returns `ok: false` (a thrown error would roll the deletion back). If the entry already has a `storageId`, deletes the new object and returns `ok: true`.                                                                                                                                                                                                                                                                                                                                   |
| `lib:finishVersion`     | internalAction                                                  | `{ versionId: string }`                                                                                | `{ state: "uploading" \| "ready", pending: { path: string, sha256: string }[] }`                                                                                                    | Checks the version's entries in batches of 500 through an internal query, with the last path as the cursor (components cannot use `paginate`): the count equals `entryCount`, every entry has a `storageId`, and no immutable entry has other bytes than the newest entry at its path in another `ready` version (two uploads can start together). Then an internal mutation re-reads the state and the entries and sets `ready` on the version and on every entry. Releases for one target run one at a time, so the batches need not be one transaction. Idempotent; `ready` returns `{ state: "ready", pending: [] }`; `deleting` and a conflict fail.                              |
| `lib:activate`          | internalMutation                                                | `{ versionId: string, afterCodePush: boolean }`                                                        | `{ previousVersionId: string \| null }`                                                                                                                                             | Requires `ready`. Sets `site.liveVersionId` and `liveAt` on the version, and `supersededAt` on the previous live version. With `afterCodePush: true` it sets `codePushAt` on the version, also when the version is live already; a file-only activation never clears it. Activating the live version again changes nothing else. `deploy` passes `afterCodePush: true`; a plain `upload` passes `false`.                                                                                                                                                                                                                                                                               |
| `lib:getLiveVersion`    | query                                                           | `{}`                                                                                                   | `{ versionId: string, liveAt: number } \| null`                                                                                                                                     | For the update hook and for `deploy`'s verification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lib:route`             | query                                                           | `{ method: "GET" \| "HEAD", url: string, headers: { name: string, value: string }[], exact: boolean }` | `{ handled: false } \| { handled: true, status: number, headers: { name: string, value: string }[], body: { storageId: string, storageUrl: string, contentType: string } \| null }` | The whole routing for one request, in one transaction. See Serving.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lib:cleanup`           | internalMutation, started hourly by `crons.ts` in the component | `{}`                                                                                                   | `{ done: boolean }`                                                                                                                                                                 | Deletes at most 200 rows per call; when work remains, returns `done: false` and schedules itself again at once with `ctx.scheduler.runAfter(0, ...)`. Rules in docs/design.md "Cleanup".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Serving (`lib:route`)

1. Read `site`; no `liveVersionId`: return
   `{ handled: true, status: 404, headers: [Cache-Control: no-store], body: null }`. Read the
   version row.
2. Config: `normalizeConfiguration(JSON.parse(config))`. When `exact` is true, force
   `html_handling: "none"` and `not_found_handling: "none"`. When the request is not a navigation
   (`Sec-Fetch-Mode` header is not `navigate`), force `not_found_handling: "none"`, so a missing
   script never gets the SPA page, also through a rewrite.
3. Build `new Request(url, { method, headers })`. Env `{ JAEGER: mockJaegerBinding() }`, an
   `Analytics` instance from the vendored `analytics.ts` with no dataset.
4. `exists(path)`: a per-request map keyed by path. Lookup: the version's entry at `path` with a
   `storageId`; else, when some entry at `path` is immutable, the newest entry at `path` with a
   `storageId` from another `ready` version (`by_ready_immutable_path`, skipping entries of a
   `deleting` version); else null. Return the entry key
   `${sha256}-${first 8 hex of sha256(contentType)}`, and remember the entry under that key. Two
   entries with the same bytes and the same content type share a key, which is correct; different
   content types get different keys.
5. `canFetch` false: return `{ handled: false }`.
6. `handleRequest` with `getByETag(key)` returning
   `{ readableStream: new ReadableStream(), contentType: entry.contentType, cacheStatus: "MISS" }`
   (the stream is never read; the caller fetches the body).
7. Post-process the response headers: status 400 or above: delete `Cache-Control`,
   `CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control`, and `Surrogate-Control`, then set
   `Cache-Control: no-store`. Status 200 or 304 whose selected entry is immutable: set
   `Cache-Control: public, max-age=31536000, immutable`.
8. Return the status, all headers, and `body` = the selected entry (`storageId`, `storageUrl` from
   `ctx.storage.getUrl`, `contentType`) when the status is 200 and the method is GET, else null.

Verify early that `Request`, `Response`, and `Headers` can be constructed inside a Convex query in
convex-test; the real runtime is checked in the first deployment. If a query cannot construct a
`Request`, build a minimal object with `url`, `method`, and `headers` that satisfies what the
handler reads, and say so in the report.

## HTTP actions (component route and `src/client`)

- Call `lib:route` with the request's method, URL, and all headers, and `exact` (false for
  `registerStaticRoutes`, true for `serveStaticAsset` unless the caller passes `exact: false`).
- `handled: false`: `registerStaticRoutes` answers 404 with `no-store`; `serveStaticAsset` returns
  `null`.
- Otherwise build the `Response`: the body is `ctx.storage.get(storageId)` inside the component's
  own route, or `fetch(storageUrl)` with its body stream in the app, only when `body` is not null;
  the status and headers come from the result.
- `registerStaticRoutes` registers the GET prefix route and, for a prefix other than `/`, the exact
  route for the prefix without its trailing slash, as the 0.3.x client does.

## Tables (schema.ts)

`versions` (`versionId`, `state`: `"uploading" | "ready" | "deleting"`, `manifestSha256`,
`entryCount`, `createdAt`, `liveAt?`, `supersededAt?`, `codePushAt?`; indexes `by_versionId`,
`by_state`, `by_codePushAt`), `versionConfigs` (`versionId`, `config`: string; index
`by_versionId`), `entries` (`versionId`, `path`, `sha256`, `size`, `contentType`, `immutable`,
`storageId?`, `ready`; indexes `by_version_path` on `[versionId, path]`, `by_ready_immutable_path`
on `[ready, immutable, path]`, `by_storageId`), `site` (`liveVersionId?`, `versionScanCursor?`,
`storageScanCursor?`; one row).

## Cleanup rule for code-push and never-activated versions

A version with `codePushAt`, and a `ready` version that never went live, are deleted only when
another version has a `codePushAt` after this version's `codePushAt` (or after its `createdAt` for
the never-live one) and that `codePushAt` is more than seven days old. File-only activations, a
rollback included, do not count: the live renderer may still be this version's. A version without
`codePushAt` is deleted seven days after `supersededAt`.
