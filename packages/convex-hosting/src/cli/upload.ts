import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseUploadArgs, type UploadOptions } from "./args.js";
import { collectFiles } from "./collectFiles.js";
import { nodeCli, runComponent, type Cli } from "./commands.js";
import { componentNameCandidates, findComponent } from "./componentName.js";
import {
  buildConfig,
  immutableMatcher,
  manifestDigest,
  manifestEntries,
  resolveVersionId,
  type ManifestEntry,
} from "./manifest.js";
import { describeTarget, readConvexEnv, resolveTarget, type Target } from "./target.js";

export const UPLOAD_CONCURRENCY = 8;
/** `finishVersion` results with the same pending files before the upload gives up. */
export const STALLED_ROUNDS = 3;

const versionProgress = z.object({
  state: z.enum(["uploading", "ready"]),
  pending: z.array(z.object({ path: z.string(), sha256: z.string() })),
});
const recordFileResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
const storageUploadResult = z.object({ storageId: z.string() });
export const activateResult = z.object({ previousVersionId: z.string().nullable() });

export interface UploadResult {
  component: string;
  versionId: string;
  entries: ManifestEntry[];
}

/**
 * Uploads `options.dist` as one version: the manifest first, then every file that the component
 * does not have yet. Activates the version unless `options.activate` is false.
 */
export async function upload(
  target: Target,
  options: UploadOptions,
  cli: Cli,
): Promise<UploadResult> {
  const files = await collectFiles(options.dist);
  const config = buildConfig(options.dist, options);
  const entries = manifestEntries(files, immutableMatcher(options.immutable));
  const versionId = resolveVersionId(
    options.dist,
    manifestDigest(config, entries),
    options.versionId,
  );
  const component = options.component ?? (await findComponent(cli, target, null));
  if (component === null) {
    const names = componentNameCandidates(null).join('" or "');
    throw new Error(
      `The component "${names}" does not answer lib:getLiveVersion on the ${describeTarget(target)}. ` +
        "Push the backend with @samebase/convex-hosting 0.4 first (npx convex deploy), and pass " +
        "--component when the instance has another name.",
    );
  }

  const run = <T>(functionName: string, args: Record<string, unknown>, result: z.ZodType<T>) =>
    runComponent(cli, target, component, functionName, args, result);
  const store = async (body: string | Uint8Array<ArrayBuffer>, contentType: string) => {
    const uploadUrl = await run("lib:generateUploadUrl", {}, z.string());
    const response = await cli.fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!response.ok) {
      throw new Error(`Storage upload failed: ${response.status} ${response.statusText}`);
    }
    return storageUploadResult.parse(await response.json()).storageId;
  };

  const bytes = entries.reduce((total, entry) => total + entry.size, 0);
  console.log(`Version ${versionId}: ${entries.length} files, ${bytes} bytes.`);
  const manifestStorageId = await store(
    JSON.stringify({ versionId, config, entries }),
    "application/json",
  );
  let progress = await run("lib:startVersion", { versionId, manifestStorageId }, versionProgress);

  const local = new Map(
    files.map((file, index) => [
      file.path,
      { localPath: file.localPath, contentType: entries[index].contentType },
    ]),
  );
  let uploaded = 0;
  let previousPending = "";
  let rounds = 0;
  while (progress.state === "uploading") {
    await forEachWithConcurrency(progress.pending, UPLOAD_CONCURRENCY, async ({ path }) => {
      const file = local.get(path);
      if (file === undefined) {
        throw new Error(`The component asked for ${path}, which is not in the manifest.`);
      }
      const storageId = await store(readFileSync(file.localPath), file.contentType);
      const recorded = await run(
        "lib:recordFile",
        { versionId, path, storageId },
        recordFileResult,
      );
      if (!recorded.ok) throw new Error(`The component rejected ${path}: ${recorded.reason}`);
      uploaded++;
      console.log(`  ${path}`);
    });
    progress = await run("lib:finishVersion", { versionId }, versionProgress);
    const pending = progress.pending
      .map((entry) => entry.path)
      .sort()
      .join(", ");
    rounds = pending === previousPending ? rounds + 1 : 1;
    previousPending = pending;
    if (progress.state === "uploading" && rounds === STALLED_ROUNDS) {
      throw new Error(
        `Version ${versionId} is not ready after ${STALLED_ROUNDS} rounds with the same pending ` +
          `files: ${pending || "none listed"}.`,
      );
    }
  }

  console.log(`Uploaded ${uploaded} files; ${entries.length - uploaded} were stored already.`);
  if (options.activate) {
    await run("lib:activate", { versionId, afterCodePush: false }, activateResult);
    console.log(`Version ${versionId} is live: ${entries.length} files, ${bytes} bytes.`);
  } else {
    console.log(
      `Version ${versionId} is ready and not live: ${entries.length} files, ${bytes} bytes.`,
    );
  }
  return { component, versionId, entries };
}

/** Runs `worker` on every item, at most `concurrency` at a time. Stops at the first failure. */
async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const runWorker = async () => {
    while (errors.length === 0 && next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  if (errors.length > 0) throw errors[0];
}

export async function uploadCommand(args: string[]): Promise<void> {
  const options = parseUploadArgs(args);
  const target = resolveTarget(readConvexEnv(process.cwd()), options.previewName);
  console.log(`Uploading to the ${describeTarget(target)}.`);
  await upload(target, options, nodeCli);
}
