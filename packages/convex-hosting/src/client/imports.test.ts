import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

// The component's functions and `routeAll` run in Convex's default runtime: Convex bundles the
// component, and the app's `convex/http.ts` with `routeAll`, without Node modules. Only the CLI
// may import `node:` modules, and in src/workers-sdk/packages/workers-shared only utils/helpers.ts and
// utils/configuration/constructConfiguration.ts do.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = [
  "component/convex.config.ts",
  "component/schema.ts",
  "component/lib.ts",
  "client/index.ts",
];

/** Specifiers of runtime imports and re-exports. `import type` and `export type` are erased. */
const STATIC = /^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

test("the component and routeAll import no Node modules", () => {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of [...source.matchAll(STATIC), ...source.matchAll(DYNAMIC)]) {
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const target = join(dirname(file), specifier);
      const typescript = target.replace(/\.js$/, ".ts");
      visit(existsSync(typescript) ? typescript : target);
    }
  };
  for (const entry of ENTRIES) visit(join(SRC, entry));

  expect(seen.size).toBeGreaterThan(ENTRIES.length);
  const nodeModules = [...external].filter(
    (specifier) => specifier.startsWith("node:") || builtinModules.includes(specifier),
  );
  expect(nodeModules).toEqual([]);
});
