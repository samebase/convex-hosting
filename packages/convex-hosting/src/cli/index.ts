#!/usr/bin/env node
import { registerHooks } from "node:module";

// The vendored files in ../workers-shared keep Cloudflare's extensionless relative imports, so a
// sync stays a clean copy. tsc keeps them as written, and Node's ESM loader needs the extension.
// This hook adds `.js` for those files only. It must run before the commands are imported.
const workersShared = new URL("../workers-shared/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(workersShared) && /^\.\.?\/.*(?<!\.js)$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const HELP = `Usage: convex-hosting <command> [options]

Commands:
  upload   Upload a build output directory as a new version of the site
  deploy   Build, push the Convex backend, upload the site, activate it, and verify it

Site options (upload and deploy):
  --dist <dir>                  Build output directory (required)
  --component <name>            Component instance name (default: probe hosting, then staticHosting)
  --preview-name <name>         Target the named preview deployment (needs a preview deploy key or
                                a login; fails with a production or development deploy key)
  --immutable <preset|glob>     Paths whose bytes never change: vite (/assets/**, default), next,
                                astro, sveltekit, or a gitignore-style glob
  --html-handling <mode>        auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none
  --not-found-handling <mode>   single-page-application, 404-page, none
  --base-path <prefix>          Path prefix that the site is served under (default: /)

upload options:
  --version-id <id>             Use this version ID instead of the stored or a new one
  --no-activate                 Upload and keep the current version live

deploy options:
  --build-command <cmd>         Build command (default: npm run build). It gets the deployment URL
                                from npx convex deploy, and CONVEX_HOSTING_VERSION_ID and
                                CONVEX_HOSTING_BASE_PATH
  --skip-build                  Upload the existing build output
  --verify-path <path>          Page that must carry the version meta tag when the build has no
                                /index.html, relative to the base path (default: /)

The target is the deployment of CONVEX_DEPLOY_KEY, the --preview-name deployment, or (upload only)
the development deployment in CONVEX_DEPLOYMENT.
`;

const [command, ...args] = process.argv.slice(2);
try {
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    console.log(HELP);
  } else if (command === "upload") {
    const { uploadCommand } = await import("./upload.js");
    await uploadCommand(args);
  } else if (command === "deploy") {
    const { deployCommand } = await import("./deploy.js");
    await deployCommand(args);
  } else {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
