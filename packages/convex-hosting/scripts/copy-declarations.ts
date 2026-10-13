// Copies the hand-written declaration files next to the generated ones. tsc emits declarations
// for .ts sources only, and version-module.d.ts must be a script file (a wildcard module name is
// only allowed in an ambient context), so it cannot be a .ts source.
import { copyFileSync } from "node:fs";

for (const name of ["types", "version-module"]) {
  copyFileSync(`src/client/${name}.d.ts`, `dist/client/${name}.d.ts`);
}
