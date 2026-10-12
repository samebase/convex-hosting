# Convex files

A private Convex component that gives native storage files a required, unique path.

The component has one table:

```ts
files: {
  path: string;
  storageId: Id<"_storage">;
}
```

Convex adds the document ID and creation time. File size, content type, and hash stay in native
storage. Each component instance has its own paths and owns its own blobs.

## Use in this workspace

Add `"@samebase/convex-files": "workspace:*"` to a private workspace package, then mount it:

```ts
import { defineComponent } from "convex/server";
import files from "@samebase/convex-files/convex.config";

const component = defineComponent("myComponent");
component.use(files);
export default component;
```

An app can mount it with `defineApp()` and `app.use(files)` instead. Run `convex dev` to generate
the component references. The [nested example](../../examples/files/README.md) has a complete upload
and file lifecycle check.

## API

Call these functions through `components.files.lib` from the parent app or component:

| Function                                   | Purpose                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `generateUploadUrl({})`                    | Create a native Convex upload URL in this component's storage. |
| `register({ path, storageId })`            | Give an uploaded blob a path and return a stable file ID.      |
| `get({ fileId })`                          | Read the file record, download URL, and native metadata.       |
| `getByPath({ path })`                      | Read the same information by path.                             |
| `list({ prefix, paginationOpts })`         | Read a page of file records in path order.                     |
| `rename({ fileId, path })`                 | Change the path while preserving the file ID and blob.         |
| `remove({ fileId })`                       | Delete the record and its blob. Repeated calls are safe.       |
| `cleanupUnregistered({ before, cursor? })` | Delete a bounded page of old, unnamed uploads.                 |

Upload bytes with an HTTP `POST` to the returned upload URL. Pass its returned `storageId` to
`register`. Registration requires a blob in this component's storage. A blob from the parent app or
another component cannot be registered.

Registration is idempotent for the same path and storage ID. A different blob at an existing path is
an error. Each blob can have only one path, so removing a file cannot break another file's
reference. A rename to an occupied path is also an error. These checks run in Convex mutations.

Paths are case-sensitive relative paths, such as `avatars/alice.png`. Leading or trailing slashes,
empty segments, `.` and `..` segments, backslashes, and control characters are rejected. Folders are
path prefixes, with no folder table. Use `prefix: "avatars/"` for that folder and `prefix: ""` for
all files. Pass the returned cursor into the next request with the same prefix.

The upload and registration are separate requests. An interrupted upload flow can leave a blob
without a path. To clean these blobs, choose a `before` timestamp that excludes uploads still in
progress. Keep the same cutoff and pass each `continueCursor` until `isDone` is true. Each call
examines at most 128 blobs and preserves all registered files and newer uploads. No cleanup runs
automatically. The cursor is a storage ID, not a snapshot: a later sweep starts without a cursor.

The host app must check access before it exposes these operations. A download URL grants access to
anyone who has it. This package adds names and file ownership, not an access-control model.

## Versioning and deployment

This package is private and uses version `0.0.0` during development. It has no public release
contract. Its source exports are for workspace use. The published hosting package does not depend on
it yet.

The component deploys with the app that uses it. It needs no separate Convex project or deployment.
Publishing an npm package does not change running deployments. An upgrade requires a dependency
update and an app deployment.

If published, its first release will be `0.1.0`, with a version and changelog independent of
hosting. The packages can stay in this repository. Before publication, add built package exports and
package-content checks, and include files in the release workflow. Publish and approve that version
before releasing a public hosting package that depends on it. A `workspace:*` dependency does not
bundle the private package into hosting.
