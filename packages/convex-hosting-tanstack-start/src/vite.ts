// Vite settings that let TanStack Start's server build run in Convex HTTP actions.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
        alias: [{ find: /^react-dom\/server$/, replacement: "react-dom/server.edge" }],
      },
    }),
    // `convex/http.ts` imports `.convex-hosting/server.js`, which `convex-hosting init` writes as a
    // placeholder. `writeBundle` runs only after a build wrote its files, unlike `closeBundle`.
    writeBundle() {
      if (this.environment.name !== "ssr") return;
      const { configFile, root, build } = this.environment.config;
      // The state folder of `convex-hosting`, next to `convex/` and the Vite config file: an app may
      // set `root` to a subfolder.
      const projectDir = configFile === undefined ? root : dirname(configFile);
      const stateDir = join(projectDir, ".convex-hosting");
      // As `convex-hosting` writes the folder: it ignores itself.
      const gitignore = join(stateDir, ".gitignore");
      if (!existsSync(gitignore)) {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(gitignore, "*\n");
      }
      // A re-export, not a copy: the entry imports its chunks by relative paths.
      const entry = relative(stateDir, resolve(root, build.outDir, "server.js"));
      writeFileSync(
        join(stateDir, "server.js"),
        "// Written by convexSsr() after the server build.\n" +
          `export { default } from ${JSON.stringify(entry.split(sep).join("/"))};\n`,
      );
    },
  };
}
