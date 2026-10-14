// An import cannot include a script declaration file, and the wildcard modules in them need an
// ambient context, so these are the package's reference directives.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./version-module.d.ts" />
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./server-module.d.ts" />
export * from "./index.js";
