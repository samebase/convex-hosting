// Bundles vinext's Worker entry, dist/server/index.js, into one module, dist/server/convex.js, that
// the Convex CLI can bundle into convex/http.ts for the Convex runtime.

import { build } from "esbuild";

// Modules that the Convex runtime does not have. vinext uses each one only for a feature that needs a
// Node or Workers host, so a stub with the names it reads when it loads is enough.
const shims: Record<string, string> = {
  // The Worker entry reads Cloudflare's tracing API from it when there is one.
  "cloudflare:workers": "",
  // The fetch cache, for `fetch` calls with `next.revalidate`.
  "node:buffer": "export const Buffer = undefined;",
  // The ISR cache hashes cache keys longer than 200 characters.
  "node:crypto": "export const createHash = undefined;",
  // The ISR cache imports it for side effects only.
  "node:fs": "",
  // The ISR cache builds its path helpers from `win32` when it loads.
  "node:path": "export default { win32: {} };",
  // The route handlers import it for side effects only, and the SSR entry loads it in development.
  "node:module": "",
  // The SSR entry calls it only when `import.meta.url` is not a file URL.
  "node:url": "export const pathToFileURL = undefined;",
};

await build({
  entryPoints: ["dist/server/index.js"],
  outfile: "dist/server/convex.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  // The Convex CLI resolves it to the runtime's AsyncLocalStorage.
  external: ["node:async_hooks"],
  // The Convex runtime has no `import.meta`. vinext's SSR entry reads these two when it loads.
  define: { "import.meta.url": '"file:///ssr/index.js"', "import.meta.filename": "undefined" },
  // The Convex runtime lacks it, and vinext calls it for a response without a body, such as the
  // redirect of `redirect()`.
  banner: { js: "globalThis.queueMicrotask ??= (task) => void Promise.resolve().then(task);" },
  plugins: [
    {
      name: "convex-shims",
      setup(build) {
        build.onResolve({ filter: new RegExp(`^(${Object.keys(shims).join("|")})$`) }, (args) => ({
          path: args.path,
          namespace: "convex-shim",
        }));
        build.onLoad({ filter: /.*/, namespace: "convex-shim" }, (args) => ({
          contents: shims[args.path],
        }));
      },
    },
  ],
});
