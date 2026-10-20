// The Vite settings that let this package's entry resolve Convex Auth, on any host. An app adds
// `convexAuth()` to its plugins, next to its host's own, such as `convexSsr()` of
// `@samebase/convex-hosting-tanstack-start` on Convex or Cloudflare's plugin on a Worker.

import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

export function convexAuth(): Plugin {
  return {
    name: "convex-auth-tanstack-start",
    config: (_, { command }) => {
      // Convex Auth is a peer: this resolves the app's copy.
      const packageJson = createRequire(import.meta.url).resolve("@convex-dev/auth/package.json");
      return {
        resolve: {
          alias: [
            // Convex Auth 2.0.0-beta.0 keeps its SSR provider in a file that its exports map does
            // not expose. The upstream fix is an export (convex/convex-auth#350 and #126).
            {
              find: /^@convex-dev\/auth\/ssr\/nextjs\/client$/,
              replacement: path.join(path.dirname(packageJson), "dist/ssr/nextjs/client.js"),
            },
          ],
        },
        // The dev server renders the aliased file through Vite and would load the rest of Convex
        // Auth through Node, each with its own copy of the React contexts that the provider sets
        // and the hooks read.
        ssr: { noExternal: ["@convex-dev/auth"] },
        // Vite pre-bundles only what it finds in the app's own files, and TanStack Start keeps
        // this package out of pre-bundling (it lists `@tanstack/react-start` as a peer), so Vite
        // finds the entry's browser imports only on the first page load, and reloads the page. The
        // same holds for the imports of the aliased file, which Vite reads from source when it
        // collects the page's styles.
        optimizeDeps:
          command === "build"
            ? undefined
            : {
                include: [
                  "convex/browser",
                  "convex/react",
                  "convex/values",
                  "@convex-dev/auth/methods/oauth/react",
                  "@convex-dev/auth/react",
                  "@convex-dev/auth/ssr/nextjs/client",
                ],
              },
      };
    },
  };
}
