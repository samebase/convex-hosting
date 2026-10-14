// Vite settings that let TanStack Start's server build run in Convex HTTP actions.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
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
    writeBundle(options, bundle) {
      if (this.environment.name !== "ssr") return;
      // The state folder of `convex-hosting`: the CLI finds it in the working directory, and
      // `convex-hosting deploy --build` runs the build in the project directory.
      const stateDir = resolve(process.cwd(), ".convex-hosting");
      // As `convex-hosting` writes the folder: it ignores itself.
      const gitignore = join(stateDir, ".gitignore");
      if (!existsSync(gitignore)) {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(gitignore, "*\n");
      }
      const entries = Object.values(bundle).flatMap((output) =>
        output.type === "chunk" && output.isEntry ? [output] : [],
      );
      // Start builds this environment from one input, its server entry. When a plugin adds another
      // entry, the server entry is the chunk that Start's preview server loads: the one named after
      // that input.
      const { input } = this.environment.config.build.rolldownOptions;
      const entry =
        entries.length === 1
          ? entries[0]
          : entries.find(
              (chunk) =>
                typeof input === "string" && chunk.name === basename(input, extname(input)),
            );
      if (entry === undefined) {
        throw new Error(
          `convexSsr() cannot tell the server entry among the entry chunks ${JSON.stringify(entries.map((chunk) => chunk.fileName))}.`,
        );
      }
      // Rolldown leaves `dir` unset only for `output.file`, which a build of more than one chunk
      // rejects, and Start's server build splits each route into a chunk.
      // @ts-expect-error `dir` is set: see above.
      const outDir: string = options.dir;
      // A re-export, not a copy: the entry imports its chunks by relative paths. The entry's name
      // comes from the bundle: without `"type": "module"` in `package.json`, Vite emits `.mjs`.
      const target = relative(stateDir, join(outDir, entry.fileName));
      writeFileSync(
        join(stateDir, "server.js"),
        "// Written by convexSsr() after the server build.\n" +
          `export { default } from ${JSON.stringify(target.split(sep).join("/"))};\n`,
      );
    },
  };
}
