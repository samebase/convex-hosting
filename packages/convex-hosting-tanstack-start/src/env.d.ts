// What the server entry reads from `import.meta.env`. `convexSsr()` defines it in builds; a dev
// server leaves it undefined.
interface ImportMetaEnv {
  readonly CONVEX_HOSTING_VERSION_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
