import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vite-plus/test";

// Convex bundles the component and the app-side client for its own runtime. That bundle must never
// include the CLI's Node modules, such as the vendored helpers that read files with `node:fs`, so
// the static import graph of these entry points has no `node:` specifier.
const SRC = dirname(fileURLToPath(import.meta.url));
const ENTRY_POINTS = ["component/lib.ts", "component/http.ts", "client/index.ts"];

test("the component and the client import no node: module", () => {
  const visited = new Set<string>();
  const nodeImports: string[] = [];
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      if (fileName.startsWith("node:")) {
        nodeImports.push(`${relative(SRC, file)} imports ${fileName}`);
      } else if (fileName.startsWith(".")) {
        // `./x.js` and the vendored `./x` both name `./x.ts`.
        visit(join(dirname(file), `${fileName.replace(/\.js$/, "")}.ts`));
      }
    }
  };
  for (const entryPoint of ENTRY_POINTS) visit(join(SRC, entryPoint));

  // The walk follows relative imports, so it reaches the contract module.
  expect(visited).toContain(join(SRC, "contract.ts"));
  expect(nodeImports).toEqual([]);
});
