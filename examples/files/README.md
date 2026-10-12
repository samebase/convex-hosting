# Nested file component example

This backend-only example proves the component tree `app -> fileOwner -> files`. It uses the private
workspace package. Existing hosting examples keep their current storage.

From the repository root:

```sh
pnpm install
cd examples/files
pnpm exec convex dev --once --typecheck-components --run smoke:run
```

Use a separate development deployment for this example. For an account-free local deployment, set
`CONVEX_AGENT_MODE=anonymous` before running the command.

The internal `smoke:run` action calls the parent component. The parent uploads a text file to the
child's native storage, registers a path, reads metadata, downloads the bytes, lists the path,
renames the file, and removes it. It also checks the cleanup query with a zero cutoff, which deletes
no uploads. A successful run returns `null`. The named test file is removed even if a later check
fails.

The files package and both levels of generated component types are checked in. To refresh them, run
the same command. The package exports source while it is private, so codegen does not need a prior
package build.

There is no frontend or public function in the example. App-facing endpoints must add the app's
access checks before they call component functions.
