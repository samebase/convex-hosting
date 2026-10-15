// The `./server-build` entry, which `convex/http.ts` loads with `import type {}`. An import cannot
// include a script declaration file, and the wildcard modules in it need an ambient context, so
// this module is the reference directive.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./server-module.d.ts" />
export {};
