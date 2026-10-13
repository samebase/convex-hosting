#!/usr/bin/env node
import { deployCommand } from "./deploy.js";
import { uploadCommand } from "./upload.js";

const HELP = `Usage: convex-hosting <command> [options]

Commands:
  upload   Upload a build output directory as a new version of the site
  deploy   Build, push the Convex backend, upload the site, activate it, and verify it

Site options (upload and deploy):
  --dist <dir>                  Build output directory (required)
  --component <name>            Component instance name (default: hosting)
  --preview-name <name>         Target the named preview deployment (needs a project's preview
                                deploy key or a login; fails with the deploy key of one deployment)
  --immutable <preset|glob>     Paths whose bytes never change: vite (/assets/**, default), next,
                                astro, sveltekit, or a gitignore-style glob
  --html-handling <mode>        auto-trailing-slash (default), force-trailing-slash,
                                drop-trailing-slash, none
  --not-found-handling <mode>   none (default), single-page-application, 404-page
  --base-path <prefix>          Path prefix that the site is served under (default: /)

upload options:
  --version-id <id>             Use this version ID instead of the stored or a new one
  --no-activate                 Upload and keep the current version live

deploy options:
  --build-command <cmd>         Build command (default: npm run build). It gets the deployment URL
                                from npx convex deploy, and CONVEX_HOSTING_VERSION_ID and
                                CONVEX_HOSTING_BASE_PATH
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
    await uploadCommand(args);
  } else if (command === "deploy") {
    await deployCommand(args);
  } else {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
