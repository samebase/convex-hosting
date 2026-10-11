#!/usr/bin/env node
/**
 * CLI for Convex Static Hosting
 *
 * Commands:
 *   deploy              One-shot deployment (Convex backend + static files)
 *   upload              Upload static files to Convex storage
 */

const command = process.argv[2];

async function main() {
  switch (command) {
    case "deploy":
      // Pass remaining args to deploy command
      process.argv.splice(2, 1);
      await import("./deploy.js");
      break;

    case "upload":
      // Pass remaining args to upload command
      process.argv.splice(2, 1);
      await import("./upload.js");
      break;

    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log("");
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
Convex Static Hosting CLI

Usage:
  npx @convex-dev/static-hosting <command> [options]

Commands:
  deploy              One-shot deployment (Convex backend + static files)
  upload              Upload static files to Convex storage

Examples:
  # One-shot deployment
  npx @convex-dev/static-hosting deploy

  # Upload only (no Convex backend deploy)
  npx @convex-dev/static-hosting upload --build --prod

Run '<command> --help' for more information on a specific command.
`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
