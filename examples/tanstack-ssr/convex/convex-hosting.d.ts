// `convex-hosting dev` and `deploy` write this module into the gitignored `.convex-hosting/`, like a
// build artifact. This declaration types it before the first of them.
declare module "*/.convex-hosting/version.js" {
  export const versionId: string;
}
