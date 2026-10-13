// An import cannot include a script declaration file, and the wildcard module in it needs an
// ambient context, so this is the one reference directive in the package.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./version-module.d.ts" />
export * from "./index.js";
