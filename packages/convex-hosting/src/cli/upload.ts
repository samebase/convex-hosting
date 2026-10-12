#!/usr/bin/env node
/**
 * CLI tool to upload static files to a Convex convex-hosting component.
 *
 * Usage:
 *   npx @samebase/convex-hosting upload [options]
 *
 * Options:
 *   --dist <path>            Path to dist directory (default: ./dist)
 *   --component <name>       Component instance name (default: hosting)
 *   --prod                   Deploy to production deployment
 *   --preview-name <name>    Upload to the named preview deployment
 *   --build                  Run the frontend build before uploading
 *   --build-command <cmd>    Override the frontend build command
 *   --spa / --no-spa         Enable or disable SPA fallback
 *   --concurrency <n>        Parallel upload workers (default: 5)
 *   --help                   Show help
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { runConvexAsync, spawnShell } from "./commands.js";
import { chunkBySerializedArgument, MAX_CONVEX_ARGUMENT_BYTES } from "./argumentChunks.js";
import { parseUploadArgs } from "./args.js";
import {
  componentNameCandidates,
  isLegacyAutoDetected,
  legacyComponentNameWarning,
} from "./componentName.js";
import { collectFiles } from "./collectFiles.js";

function showHelp(): void {
  console.log(`
Usage: npx @samebase/convex-hosting upload [options]

Upload static files from a dist directory to Convex storage.

Options:
  -d, --dist <path>           Path to dist directory (default: ./dist)
  -c, --component <name>      Static-hosting component instance name (default: hosting)
      --prod                  Deploy to production deployment
      --preview-name <name>   Upload to the named preview deployment
  -b, --build                 Run the build command with VITE_CONVEX_URL +
                              CONVEX_HOSTING_BASE_PATH set before uploading
      --build-command <cmd>   Build command to run (default: 'npm run build').
                              Implies --build.
      --no-spa                Disable SPA fallback for this deployment (return a
                              404 instead of falling back to /index.html)
      --spa                   Enable SPA fallback for this deployment (default)
  -j, --concurrency <n>       Number of parallel uploads (default: 5)
  -h, --help                  Show this help message

Examples:
  # Upload to Convex storage
  npx @samebase/convex-hosting upload
  npx @samebase/convex-hosting upload --dist ./build --prod
  npx @samebase/convex-hosting upload --build --prod
`);
}

// Global flag for production mode
let useProd = true;
let previewName: string | null = null;
const MAX_ASSETS_PER_DEPLOYMENT = 1800;
const MAX_MANIFEST_SERIALIZED_BYTES = 2 * 1024 * 1024;
// A Convex CLI function result can be truncated around 64 KiB. Signed upload
// URLs are long enough that 250 sometimes crosses that boundary.
const UPLOAD_URL_BATCH_SIZE = 100;
const MAINTENANCE_PAGE_SIZE = 256;
const MAX_MAINTENANCE_PAGES = 20;

interface DeploymentUrls {
  /** CONVEX_SITE_URL, including the component's mount prefix. */
  siteUrl: string;
  /** CONVEX_CLOUD_URL, the backend URL the frontend connects to. */
  cloudUrl: string;
}

/**
 * Resolve the component's deployment URLs and the instance name that answered.
 *
 * When the caller relied on the default name we also probe the
 * @convex-dev/static-hosting name, so an app that kept that instance works without
 * `--component staticHosting`
 * on every command; landing on the legacy name prints a one-time warning. Bails
 * the CLI if no candidate is deployed. Uploading wouldn't work either, so a
 * fallback would only hide the real problem.
 */
async function fetchUrls(
  requested: string,
): Promise<{ urls: DeploymentUrls; componentName: string }> {
  const candidates = componentNameCandidates(requested);
  for (const name of candidates) {
    try {
      const out = await convexRunAsync(name, "lib:getUrls", {}, { quiet: true });
      const urls: DeploymentUrls = JSON.parse(out);
      if (isLegacyAutoDetected(requested, name)) {
        console.warn(legacyComponentNameWarning(name));
      }
      return { urls, componentName: name };
    } catch {
      // Try the next candidate name.
    }
  }
  console.error(
    `Could not reach component ${candidates
      .map((name) => `"${name}"`)
      .join(" or ")}. Deploy the Convex backend first and ensure --component ` +
      `matches the name in convex.config.ts.`,
  );
  process.exit(1);
}

function convexRunAsync(
  componentName: string | undefined,
  functionPath: string,
  args: Record<string, unknown> = {},
  options: { quiet?: boolean } = {},
): Promise<string> {
  const serializedArgs = JSON.stringify(args);
  const argumentBytes = Buffer.byteLength(serializedArgs);
  if (argumentBytes > MAX_CONVEX_ARGUMENT_BYTES) {
    throw new Error(
      "The Convex function argument is " +
        argumentBytes +
        " bytes, which exceeds the portable command-line limit. " +
        "This is an internal chunking error; please report it.",
    );
  }

  return runConvexAsync(
    [
      "run",
      ...(componentName ? ["--component", componentName] : []),
      functionPath,
      serializedArgs,
      "--typecheck=disable",
      "--codegen=disable",
      ...(useProd ? ["--prod"] : []),
      ...(previewName === null ? [] : ["--preview-name", previewName]),
    ],
    options,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanUpAbandonedUploads(componentName: string): Promise<void> {
  let discarded = 0;
  let deletedFiles = 0;

  try {
    let stagingDrained = false;
    for (let page = 0; page < MAX_MAINTENANCE_PAGES; page++) {
      const output = await convexRunAsync(componentName, "lib:cleanupAbandonedStaging", {
        limit: MAINTENANCE_PAGE_SIZE,
      });
      const result: unknown = JSON.parse(output);
      if (
        !result ||
        typeof result !== "object" ||
        !("discarded" in result) ||
        !("deletedFiles" in result) ||
        typeof result.discarded !== "number" ||
        typeof result.deletedFiles !== "number"
      ) {
        throw new Error("Component returned invalid staging cleanup data");
      }
      discarded += result.discarded;
      deletedFiles += result.deletedFiles;
      if (result.discarded < MAINTENANCE_PAGE_SIZE) {
        stagingDrained = true;
        break;
      }
    }
    if (!stagingDrained) {
      console.warn(
        "Warning: Staging cleanup reached its per-run maintenance limit; a later upload will continue it.",
      );
    }

    deletedFiles += await cleanUpPendingStorage(componentName);
    deletedFiles += await cleanUpUnreferencedStorage(componentName);

    if (discarded > 0 || deletedFiles > 0) {
      console.log(
        `Recovered ${discarded} abandoned manifest record(s) and removed ${deletedFiles} old unreferenced file(s).`,
      );
    }
  } catch (cleanupError) {
    console.warn(
      "Warning: Could not finish abandoned-upload maintenance: " + errorMessage(cleanupError),
    );
  }
}

async function cleanUpUnreferencedStorage(componentName: string): Promise<number> {
  let deleted = 0;
  for (let page = 0; page < MAX_MAINTENANCE_PAGES; page++) {
    const output = await convexRunAsync(componentName, "lib:cleanupUnreferencedStorage", {
      limit: MAINTENANCE_PAGE_SIZE,
    });
    const result: unknown = JSON.parse(output);
    if (
      !result ||
      typeof result !== "object" ||
      !("deleted" in result) ||
      !("needsAnotherPass" in result) ||
      typeof result.deleted !== "number" ||
      typeof result.needsAnotherPass !== "boolean"
    ) {
      throw new Error("Component returned invalid storage cleanup data");
    }
    deleted += result.deleted;
    if (!result.needsAnotherPass) return deleted;
  }
  console.warn(
    "Warning: Orphan storage cleanup reached its per-run maintenance limit; a later upload will continue it.",
  );
  return deleted;
}

async function cleanUpPendingStorage(componentName: string): Promise<number> {
  let deleted = 0;
  for (let page = 0; page < MAX_MAINTENANCE_PAGES; page++) {
    const output = await convexRunAsync(componentName, "lib:cleanupPendingStorage", {
      limit: MAINTENANCE_PAGE_SIZE,
    });
    const result: unknown = JSON.parse(output);
    if (
      !result ||
      typeof result !== "object" ||
      !("deleted" in result) ||
      !("needsAnotherPass" in result) ||
      typeof result.deleted !== "number" ||
      typeof result.needsAnotherPass !== "boolean"
    ) {
      throw new Error("Component returned invalid pending-storage cleanup data");
    }
    deleted += result.deleted;
    if (!result.needsAnotherPass) return deleted;
  }
  console.warn(
    "Warning: Published storage cleanup reached its per-run maintenance limit; a later upload will continue it.",
  );
  return deleted;
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;

  async function runWorker() {
    while (firstError === undefined) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (firstError !== undefined) throw firstError;
}

async function cleanUpFailedUpload(
  componentName: string,
  deploymentId: string,
  fileStorageIds: string[],
  publishAttempted: boolean,
) {
  let discardSucceeded = false;
  try {
    const output = await convexRunAsync(componentName, "lib:discardStagedDeployment", {
      deploymentId,
    });
    const result: unknown = JSON.parse(output);
    if (
      !result ||
      typeof result !== "object" ||
      !("discarded" in result) ||
      typeof result.discarded !== "number"
    ) {
      throw new Error("Component returned an invalid discard result");
    }
    discardSucceeded = true;
  } catch (cleanupError) {
    console.warn("Warning: Could not discard the staged manifest: " + errorMessage(cleanupError));
  }

  // Convex mutations have a single transaction order. If discard succeeds,
  // either it removed the staged rows before a late publish could use them, or
  // publish already committed and removed them first. In the latter case the
  // component cleanup below sees the live references and keeps those files.
  const canCleanComponentFiles = !publishAttempted || discardSucceeded;
  if (fileStorageIds.length > 0 && canCleanComponentFiles) {
    try {
      let deleted = await cleanUpPendingStorage(componentName);
      let stillReferenced = 0;
      const chunks = chunkBySerializedArgument(fileStorageIds, (fileStorageIds) => ({
        fileStorageIds,
      }));
      for (const fileStorageIds of chunks) {
        const output = await convexRunAsync(componentName, "lib:deleteUploadedFiles", {
          fileStorageIds,
        });
        const result: unknown = JSON.parse(output);
        if (
          !result ||
          typeof result !== "object" ||
          !("deleted" in result) ||
          !("stillReferenced" in result) ||
          typeof result.deleted !== "number" ||
          typeof result.stillReferenced !== "number"
        ) {
          throw new Error("Component returned invalid failed-upload cleanup data");
        }
        deleted += result.deleted;
        stillReferenced += result.stillReferenced;
      }
      console.log(`Removed ${deleted} unreferenced file(s) during failure cleanup.`);
      if (stillReferenced > 0) {
        console.warn(
          `Kept ${stillReferenced} registered file(s). The publish may have completed even though its response was lost.`,
        );
      }
    } catch (cleanupError) {
      console.warn(
        "Warning: Could not remove component files from the failed upload: " +
          errorMessage(cleanupError),
      );
    }
  } else if (fileStorageIds.length > 0) {
    console.warn(
      `${fileStorageIds.length} component file(s) were left in place because the CLI could not cancel or confirm the publish.`,
    );
  }
}

async function uploadWithConcurrency(
  files: Array<{ path: string; localPath: string; contentType: string }>,
  componentName: string,
  deploymentId: string,
  concurrency: number,
  spaFallback: boolean,
): Promise<void> {
  const total = files.length;
  const fileStorageIds: string[] = [];
  let completed = 0;
  const allAssets: Array<{
    path: string;
    fileStorageId: string;
    contentType: string;
    deploymentId: string;
  }> = [];
  let publishAttempted = false;

  try {
    if (files.length > 0) {
      // Keep both the Convex array value and the child-process stdout buffer
      // bounded, even for a deployment with thousands of files.
      console.log(`  Generating ${files.length} upload URLs...`);
      const uploadUrls: string[] = [];
      for (let offset = 0; offset < files.length; offset += UPLOAD_URL_BATCH_SIZE) {
        const count = Math.min(UPLOAD_URL_BATCH_SIZE, files.length - offset);
        const urlsOutput = await convexRunAsync(componentName, "lib:generateUploadUrls", { count });
        const batch: unknown = JSON.parse(urlsOutput);
        if (
          !Array.isArray(batch) ||
          batch.length !== count ||
          !batch.every((url) => typeof url === "string")
        ) {
          throw new Error("Component returned invalid upload URLs");
        }
        uploadUrls.push(...batch);
      }

      // Step 2: Upload all files in parallel via fetch
      const storageIds: string[] = new Array(files.length);
      await forEachWithConcurrency(files, concurrency, async (file, idx) => {
        const content = readFileSync(file.localPath);
        const response = await fetch(uploadUrls[idx], {
          method: "POST",
          headers: { "Content-Type": file.contentType },
          body: content,
        });
        if (!response.ok) {
          throw new Error(
            "Storage upload failed for " +
              file.path +
              ": " +
              response.status +
              " " +
              response.statusText,
          );
        }
        const result: unknown = await response.json();
        if (
          !result ||
          typeof result !== "object" ||
          !("storageId" in result) ||
          typeof result.storageId !== "string"
        ) {
          throw new Error("Storage upload returned no storageId for " + file.path);
        }
        const { storageId } = result;
        storageIds[idx] = storageId;
        fileStorageIds.push(storageId);
        completed++;
        const isHtml = file.contentType.startsWith("text/html");
        console.log(
          `  [${completed}/${total}] ${file.path} (${isHtml ? "storage/html" : "storage"})`,
        );
      });

      for (let i = 0; i < files.length; i++) {
        allAssets.push({
          path: files[i].path,
          fileStorageId: storageIds[i],
          contentType: files[i].contentType,
          deploymentId,
        });
      }
    }

    // Bound nested file registrations as well as the serialized CLI argument.
    // Staged rows stay invisible until the complete deployment publishes.
    const manifestChunks: (typeof allAssets)[] = [];
    for (let offset = 0; offset < allAssets.length; offset += 100) {
      manifestChunks.push(
        ...chunkBySerializedArgument(allAssets.slice(offset, offset + 100), (assets) => ({
          assets,
        })),
      );
    }
    for (let index = 0; index < manifestChunks.length; index++) {
      console.log(`  Staging manifest chunk ${index + 1}/${manifestChunks.length}...`);
      await convexRunAsync(componentName, "lib:stageAssets", {
        assets: manifestChunks[index],
      });
    }

    // Publish the staged manifest, SPA setting, and old-asset GC in one
    // mutation. The previous deployment stays intact if this call fails.
    console.log("  Publishing deployment...");
    publishAttempted = true;
    await convexRunAsync(componentName, "lib:publishDeployment", {
      currentDeploymentId: deploymentId,
      expectedAssetCount: allAssets.length,
      spaFallback,
    });
  } catch (error) {
    if (publishAttempted) {
      try {
        const output = await convexRunAsync(componentName, "lib:getCurrentDeployment");
        const current: unknown = JSON.parse(output);
        if (
          current &&
          typeof current === "object" &&
          "currentDeploymentId" in current &&
          current.currentDeploymentId === deploymentId
        ) {
          console.warn(
            "The publish completed, but the CLI could not read a valid response. The new deployment is live and its files were kept.",
          );
          return;
        }
      } catch (reconcileError) {
        console.warn(
          "Warning: Could not determine whether the publish completed: " +
            errorMessage(reconcileError),
        );
      }
    }

    await cleanUpFailedUpload(componentName, deploymentId, fileStorageIds, publishAttempted);
    throw error;
  }
}

function estimateManifestBytes(
  files: Array<{ path: string; contentType: string }>,
  deploymentId: string,
): number {
  // IDs returned by Convex storage are much shorter than this.
  // The generous placeholder lets us reject oversized path metadata before
  // uploading while the component still enforces the exact serialized size.
  const locationPlaceholder = "x".repeat(128);
  return Buffer.byteLength(
    JSON.stringify(
      files.map((file) => ({
        path: file.path,
        fileStorageId: locationPlaceholder,
        contentType: file.contentType,
        deploymentId,
      })),
    ),
  );
}

async function main(): Promise<void> {
  const args = parseUploadArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Set global prod flag
  useProd = args.prod;
  previewName = args.previewName;

  // The component knows both its CONVEX_SITE_URL (where the app is served,
  // including the mount prefix) and CONVEX_CLOUD_URL (what the frontend
  // connects to). We fetch both in one call and trust neither hostname. This
  // also resolves the instance name actually mounted (default or legacy).
  const {
    urls: { siteUrl: componentSiteUrl, cloudUrl: convexUrl },
    componentName: resolvedComponentName,
  } = await fetchUrls(args.component);

  // Run build if requested
  if (args.build) {
    const basePath = new URL(componentSiteUrl).pathname || "/";

    const envLabel =
      previewName === null ? (useProd ? "production" : "development") : `preview (${previewName})`;
    console.log(`🔨 Building for ${envLabel}...`);
    console.log(`   Build command: ${args.buildCommand}`);
    console.log(`   VITE_CONVEX_URL=${convexUrl}`);
    console.log(`   CONVEX_HOSTING_BASE_PATH=${basePath}`);
    console.log("");

    const buildResult = spawnShell(args.buildCommand, {
      ...process.env,
      VITE_CONVEX_URL: convexUrl,
      CONVEX_HOSTING_BASE_PATH: basePath,
    });

    if (buildResult !== 0) {
      console.error("Build failed.");
      process.exit(1);
    }

    console.log("");
  }

  const distDir = resolve(args.dist);
  const componentName = resolvedComponentName;

  // Convex storage deployment

  if (!existsSync(distDir)) {
    console.error(`Error: dist directory not found: ${distDir}`);
    console.error("Run your build command first (e.g., 'npm run build' or add --build flag)");
    process.exit(1);
  }

  const deploymentId = randomUUID();
  const { files, skipped } = collectFiles(distDir);
  for (const path of skipped) {
    console.log(`Skipping ${path}: convex-hosting does not apply hosting rule files.`);
  }
  if (files.length === 0) {
    console.error(`Error: dist directory is empty: ${distDir}`);
    console.error("Refusing to replace the live deployment with no files.");
    process.exit(1);
  }
  if (!files.some((file) => file.path === "/index.html")) {
    console.error(`Error: dist directory has no index.html: ${distDir}`);
    console.error("Refusing to publish a static site without its entry point.");
    process.exit(1);
  }
  if (files.length > MAX_ASSETS_PER_DEPLOYMENT) {
    console.error(
      `Error: dist directory contains ${files.length} files; the supported maximum is ${MAX_ASSETS_PER_DEPLOYMENT}.`,
    );
    console.error(
      "Reduce the number of emitted files so publication stays within Convex transaction limits.",
    );
    process.exit(1);
  }
  const estimatedManifestBytes = estimateManifestBytes(files, deploymentId);
  if (estimatedManifestBytes > MAX_MANIFEST_SERIALIZED_BYTES) {
    console.error(
      `Error: asset manifest metadata is approximately ${estimatedManifestBytes} bytes; the supported maximum is ${MAX_MANIFEST_SERIALIZED_BYTES}.`,
    );
    console.error(
      "Shorten emitted asset paths or reduce the number of files so publication stays within Convex transaction byte limits.",
    );
    process.exit(1);
  }

  await cleanUpAbandonedUploads(componentName);

  const envLabel =
    previewName === null ? (useProd ? "production" : "development") : `preview (${previewName})`;
  console.log(`🚀 Deploying to ${envLabel} environment`);
  console.log("🔒 Using secure internal functions (requires Convex CLI auth)");
  console.log(`Uploading ${files.length} files with deployment ID: ${deploymentId}`);
  console.log(`Component: ${componentName}`);
  console.log("");

  await uploadWithConcurrency(
    files,
    componentName,
    deploymentId,
    args.concurrency,
    args.spaFallback,
  );

  console.log("");

  let deletedCount = 0;
  try {
    // Publish queues only IDs from the old live manifest. Deleting that queue
    // cannot race with files from another uploader that are not staged yet.
    deletedCount += await cleanUpPendingStorage(componentName);
  } catch (cleanupError) {
    console.warn(
      "Warning: The new deployment is live, but old component storage could not be fully removed: " +
        errorMessage(cleanupError),
    );
  }

  if (deletedCount > 0) {
    console.log(`Cleaned up ${deletedCount} old storage file(s) from previous deployments`);
  }

  console.log("");
  console.log("✨ Upload complete!");

  console.log("");
  console.log(`Your app is now available at: ${componentSiteUrl}`);
}

main().catch((error) => {
  console.error("Upload failed:", error);
  process.exit(1);
});
