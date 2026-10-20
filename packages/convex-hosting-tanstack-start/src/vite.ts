// Vite settings that let TanStack Start's server build run in Convex HTTP actions.

import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function convexSsr(): Plugin {
  return {
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
  };
}
