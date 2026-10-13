// `convex-hosting deploy` writes this module into the gitignored `.convex-hosting/`, like a build
// artifact. This declaration types it before the first deploy.
declare module "*/.convex-hosting/version.js" {
  export const versionId: string;
}
