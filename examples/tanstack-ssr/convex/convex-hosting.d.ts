// `convex-hosting upload` writes this module into the gitignored `.convex-hosting/`, like a build
// artifact. This declaration types it before the first upload.
declare module "*/.convex-hosting/version.js" {
  export const versionId: string;
}
