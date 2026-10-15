// Copies the hand-written declaration files next to the generated ones. tsc emits declarations
// for .ts sources only, and the module declarations must be script files (a wildcard module name is
// only allowed in an ambient context), so they cannot be .ts sources.
import { copyFileSync } from "node:fs";

for (const name of ["types", "version-module"]) {
  copyFileSync(`src/client/${name}.d.ts`, `dist/client/${name}.d.ts`);
}
