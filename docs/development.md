# Development

The inner loop is your framework's dev server, such as Vite's, which serves the frontend locally
with hot reload against the development deployment's URL from `.env.local`, plus `npx convex dev`,
which pushes your function changes. Neither needs a deploy.

When the development deployment should serve the current build, run the one-shot command:

```sh
npx convex-hosting deploy --dev --build "vite build" --dist dist --not-found-handling single-page-application
```

`deploy --dev` goes to the development deployment of this checkout, the one in `.env.local`. It runs
the build itself, uploads `--dist`, writes `.convex-hosting/version.js`, and pushes with
`npx convex run --push`, which works whether or not `npx convex dev` runs. The build runs with your
environment, so the framework reads the deployment's URL from `.env.local` (Vite reads
`VITE_CONVEX_URL`). Against an anonymous local deployment, `deploy --dev` needs `npx convex dev`
running, because without it every Convex CLI call starts and stops its own backend and the upload's
requests find nothing; cloud development deployments do not have this constraint. There is no watch
mode: a build, an upload, and a push per change is not an inner loop, and Cloudflare's own tooling
works the same way, with a local dev server and a push on demand.

Two cases are transient:

- A server-rendered app imports its server build in `convex/http.ts`, so a running `npx convex dev`
  pushes after the build, before `deploy --dev` writes the new version. Until `deploy --dev` ends,
  the new pages refer to files that answer 404.
- A production deploy writes production's version to the version file, and a running
  `npx convex dev` pushes it to the development deployment, where that version does not exist, until
  the next `deploy --dev`. Run production deploys in CI or in a separate checkout.

## Tests and codegen

`convex/http.ts` imports two files that only a build and a deploy write:
`.convex-hosting/version.js` and, in a server-rendered app, the server build, such as
`dist/server/server.js`.

- A convex-test test that calls `t.fetch` loads `convex/http.ts`. Mock both modules in the test
  file, with paths relative to it; a files-only app mocks only the version module:

  ```ts
  vi.mock("../dist/server/server.js", () => ({ default: { fetch: async () => new Response() } }));
  vi.mock("../.convex-hosting/version.js", () => ({ versionId: "test" }));
  ```

- `npx convex codegen` bundles `convex/http.ts`, so before the first `deploy --dev` it fails with
  "Could not resolve". After it, `npx convex dev` regenerates `convex/_generated` at each push, also
  after a change to `convex/convex.config.ts`. Commit `convex/_generated`, as the examples do, so a
  fresh clone builds before its first deploy.

## Open tabs after a deploy

A page opened before a deploy keeps asking for its hashed files, which the new version does not
have, as on Cloudflare: they answer 404, or the shell on a files-only single-page app. To reload
open tabs on a new version, add a query that returns the bundled version:

```ts
// convex/siteVersion.ts
import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

export const get = query({ args: {}, returns: v.string(), handler: () => versionId });
```

and reload when its value changes after the first one:

```tsx
import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "../convex/_generated/api";

export function useReloadOnNewVersion() {
  const versionId = useQuery(api.siteVersion.get);
  const first = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (versionId === undefined) return;
    first.current ??= versionId;
    if (versionId !== first.current) location.reload();
  }, [versionId]);
}
```
