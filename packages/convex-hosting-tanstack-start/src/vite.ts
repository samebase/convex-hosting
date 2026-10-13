// Vite settings that let TanStack Start's server build run in Convex HTTP actions.

import type { Plugin } from "vite";

export function convexSsr(): Plugin {
  return {
    name: "convex-hosting-tanstack-start",
    apply: "build",
    config: () => ({
      // The server entry writes it into every page, where `convex-hosting deploy` verifies it.
      define: {
        "import.meta.env.CONVEX_HOSTING_VERSION_ID": JSON.stringify(
          process.env.CONVEX_HOSTING_VERSION_ID ?? "",
        ),
      },
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
