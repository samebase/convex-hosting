// Ambient declaration of the module that `convex-hosting deploy` writes, so an app typechecks on a
// fresh clone, before its first deploy. Script file on purpose: a wildcard module name is only allowed
// in an ambient context.
declare module "*/.convex-hosting/version.js" {
  export const versionId: string;
}
