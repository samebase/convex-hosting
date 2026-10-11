// Vite settings that let TanStack Start's server build run in Convex HTTP actions.

import type { Plugin } from "vite";

export function convexSsr(): Plugin {
  return {
    name: "convex-tanstack-start",
    apply: "build",
    config: () => ({
      ssr: {
        noExternal: true,
        resolve: { conditions: ["worker", "browser", "module", "import"] },
      },
      resolve: {
        alias: [{ find: /^react-dom\/server$/, replacement: "react-dom/server.edge" }],
      },
    }),
  };
}
