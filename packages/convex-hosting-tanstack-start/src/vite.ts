// Vite settings that let TanStack Start's server build run in Convex HTTP actions, and that let the
// `convex-auth` entry resolve Convex Auth on any host.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * The `convex-auth` entry's settings, which `convexSsr()` includes. An app on another host, such as
 * a Cloudflare Worker, adds this plugin alone.
 */
export function convexAuth(): Plugin {
  return {
    name: "convex-hosting-tanstack-start:convex-auth",
    config: (_, { command }) => {
      let packageJson: string;
      try {
        packageJson = createRequire(import.meta.url).resolve("@convex-dev/auth/package.json");
      } catch {
        // An app without Convex Auth does not use the entry.
        return;
      }
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
        // TanStack Start keeps this package out of pre-bundling (it lists `@tanstack/react-start`
        // as a peer), so Vite finds the entry's browser imports only on the first page load, and
        // reloads the page. The same holds for the imports of the aliased file, which Vite reads
        // from source when it collects the page's styles.
        optimizeDeps:
          command === "build"
            ? undefined
            : {
                include: [
                  "convex/browser",
                  "convex/react",
                  "convex/values",
                  "@convex-dev/auth/react",
                  "@convex-dev/auth/ssr/nextjs/client",
                ],
              },
      };
    },
  };
}

export function convexSsr(): Plugin[] {
  return [
    convexAuth(),
    {
      name: "convex-hosting-tanstack-start",
      apply: "build",
      config: () => ({
        ssr: {
          noExternal: true,
          resolve: { conditions: ["worker", "browser", "module", "import"] },
        },
        resolve: {
          alias: [
            { find: /^react-dom\/server$/, replacement: "react-dom/server.edge" },
            // TanStack's stream renderer imports Node's stream classes for a branch that never runs
            // where React's Web Stream renderer exists; Convex has no `node:stream` to resolve.
            {
              find: /^node:stream$/,
              replacement: fileURLToPath(new URL("./node-stream.js", import.meta.url)),
            },
          ],
        },
      }),
    },
  ];
}
