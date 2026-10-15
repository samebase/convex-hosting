// An import cannot include a script declaration file, and the wildcard module in it needs an
// ambient context, so this is the package's reference directive.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./version-module.d.ts" />
export * from "./index.js";
