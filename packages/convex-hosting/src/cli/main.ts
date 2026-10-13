import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { internal } from "../component/_generated/api.js";
import type { Id } from "../component/_generated/dataModel.js";
import { AssetConfigSchema } from "../workers-shared/utils/types.js";
import {
  deploymentFlags,
  hasComponent,
  readConvexEnv,
  runComponent,
  type Cli,
  type Target,
} from "./convex.js";
import { readDist, type DistEntry, type HandlingOptions } from "./files.js";

const USAGE = `Usage:
  convex-hosting deploy --build "<command>" --dist <dir> [options]
  convex-hosting upload --dist <dir> [options]

Options:
  --html-handling <value>       auto-trailing-slash (default), force-trailing-slash,
                                drop-trailing-slash, or none
  --not-found-handling <value>  none (default), single-page-application, or 404-page
  --component <name>            the component instance (default: hosting)
  --preview-name <name>         the preview deployment (deploy only)`;

/**
 * The CLI's state folder at the project root, like Wrangler's `.wrangler/`. It holds its own
 * `.gitignore`, so git ignores it without a line in the app's ignore file.
 */
const STATE_DIR = ".convex-hosting";

/** The file that `upload` writes and the app's `convex/http.ts` imports. */
export const VERSION_FILE = join(STATE_DIR, "version.js");

/**
 * The inner `upload` of a first install writes this file when the component is not installed yet.
 * `deploy` then uploads after the push.
 */
const FIRST_INSTALL_MARKER = join(STATE_DIR, "first-install");

/**
 * On a new clone, a user-run `upload` retries the probe every 3 seconds while `npx convex dev`
 * pushes the component, for up to 2 minutes.
 */
const PROBE_RETRY_MS = 3_000;
const PROBE_TIMEOUT_MS = 2 * 60 * 1000;

/** The CLI refreshes the lock this often while it uploads and while `npx convex deploy` runs. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Files that `upload` sends to storage at once. */
const UPLOAD_CONCURRENCY = 4;

/**
 * Files per page of uploads. A page's upload URLs are made together, and its entries are recorded
 * before the next page starts, so a retry after a crash reuses them.
 */
const UPLOAD_PAGE = 100;

/**
 * `npx convex run` passes the arguments on the command line, which Windows limits to 32,767
 * characters; `knownFiles` and `recordFiles` calls stay well below that. The component counts
 * what a call of this length reads and writes.
 */
const MAX_ARGUMENT_LENGTH = 8_000;

const htmlHandlingSchema = AssetConfigSchema.shape.html_handling.unwrap();
const notFoundHandlingSchema = AssetConfigSchema.shape.not_found_handling.unwrap();

type Options = HandlingOptions & {
  dist: string;
  component: string;
  previewName: string | undefined;
};

type Command =
  | { name: "deploy"; build: string; options: Options }
  | { name: "upload"; versionId: string | undefined; options: Options };

function parseCommand(args: string[]): Command {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      build: { type: "string" },
      dist: { type: "string" },
      "html-handling": { type: "string", default: "auto-trailing-slash" },
      "not-found-handling": { type: "string", default: "none" },
      component: { type: "string", default: "hosting" },
      "preview-name": { type: "string" },
      "version-id": { type: "string" },
    },
  });
  const [name, ...rest] = positionals;
  if ((name !== "deploy" && name !== "upload") || rest.length > 0) throw new Error(USAGE);
  if (values.dist === undefined) throw new Error(`--dist is required.\n\n${USAGE}`);
  const htmlHandling = htmlHandlingSchema.safeParse(values["html-handling"]);
  if (!htmlHandling.success) {
    throw new Error(`--html-handling must be one of: ${htmlHandlingSchema.options.join(", ")}.`);
  }
  const notFoundHandling = notFoundHandlingSchema.safeParse(values["not-found-handling"]);
  if (!notFoundHandling.success) {
    throw new Error(
      `--not-found-handling must be one of: ${notFoundHandlingSchema.options.join(", ")}.`,
    );
  }
  const options: Options = {
    dist: values.dist,
    html_handling: htmlHandling.data,
    not_found_handling: notFoundHandling.data,
    component: values.component,
    previewName: values["preview-name"],
  };
  if (name === "deploy") {
    if (values.build === undefined) throw new Error(`--build is required.\n\n${USAGE}`);
    if (values["version-id"] !== undefined) throw new Error("--version-id is an upload option.");
    return { name, build: values.build, options };
  }
  if (values.build !== undefined) throw new Error("--build is a deploy option.");
  return { name, versionId: values["version-id"], options };
}

/** Runs one `convex-hosting` command and returns the exit code. */
export async function main(args: string[], cli: Cli): Promise<number> {
  try {
    const command = parseCommand(args);
    if (command.name === "deploy") {
      await deploy(cli, command.options, command.build);
    } else if (command.versionId === undefined) {
      await upload(cli, command.options, randomUUID(), "user");
    } else {
      await upload(cli, command.options, command.versionId, "deploy");
    }
    return 0;
  } catch (error) {
    cli.log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Quotes one argument of the `--cmd` that `npx convex deploy` runs in a shell. */
function quote(arg: string): string {
  return process.platform === "win32" ? `"${arg}"` : `'${arg.replaceAll("'", `'\\''`)}'`;
}

async function deploy(cli: Cli, options: Options, build: string) {
  const target: Target = {
    component: options.component,
    flags: deploymentFlags(cli, options.previewName),
  };
  const versionId = randomUUID();
  const marker = join(cli.cwd, FIRST_INSTALL_MARKER);
  rmSync(marker, { force: true });

  const previewFlags =
    options.previewName === undefined ? [] : ["--preview-name", options.previewName];
  const innerUpload = [
    process.execPath,
    fileURLToPath(new URL("./index.js", import.meta.url)),
    "upload",
    "--dist",
    options.dist,
    "--version-id",
    versionId,
    "--html-handling",
    options.html_handling,
    "--not-found-handling",
    options.not_found_handling,
    "--component",
    options.component,
    ...previewFlags,
  ]
    .map(quote)
    .join(" ");

  // The build and the upload run in the project directory; a build must not change directory.
  // The lock stays alive through the build and the push, when no other call refreshes it.
  const exitCode = await withHeartbeat(cli, target, versionId, () =>
    cli.convexInherited(["deploy", "--cmd", `${build} && ${innerUpload}`, ...previewFlags]),
  );

  const firstInstall = existsSync(marker);
  rmSync(marker, { force: true });
  if (exitCode !== 0) {
    // On a first install the inner upload took no lock. When the build failed on a first install,
    // the component does not exist and this call fails too; the deploy has failed either way.
    if (!firstInstall) {
      try {
        await runComponent(
          cli,
          target,
          internal.lib.finishDeploy,
          { versionId, pushed: false },
          z.null(),
        );
      } catch (error) {
        cli.log(`Could not release the deploy lock: ${String(error)}`);
      }
    }
    throw new Error(`npx convex deploy failed with exit code ${exitCode}.`);
  }
  if (firstInstall) await upload(cli, options, versionId, "afterPush");
  await runComponent(cli, target, internal.lib.finishDeploy, { versionId, pushed: true }, z.null());
  cli.log(`Deployed version ${versionId}.`);
}

/**
 * - `user`: a developer uploads to the development deployment that `npx convex dev` pushes. The
 *   calls go where `npx convex run` goes by default, and the upload ends the deploy with
 *   `finishDeploy`. On a new clone, before the component exists, it writes the version file for
 *   `npx convex dev` to push and waits for the component.
 * - `deploy`: the upload inside `npx convex deploy --cmd`. Its calls go where the deploy goes.
 * - `afterPush`: the upload of a first install, after the push installed the component.
 */
type UploadMode = "user" | "deploy" | "afterPush";

async function upload(cli: Cli, options: Options, versionId: string, mode: UploadMode) {
  // A user-run upload calls `finishDeploy` at once, which deletes the version that the deployment's
  // code still names. `npx convex dev` then pushes the new id to the development deployment, but
  // nobody pushes a preview or a deployment of a deploy key after a standalone upload.
  if (
    mode === "user" &&
    (options.previewName !== undefined || readConvexEnv(cli).CONVEX_DEPLOY_KEY)
  ) {
    throw new Error(
      "convex-hosting upload targets the development deployment that npx convex dev pushes. For a " +
        "preview or a CONVEX_DEPLOY_KEY, use convex-hosting deploy.",
    );
  }
  const target: Target = {
    component: options.component,
    flags: mode === "user" ? [] : deploymentFlags(cli, options.previewName),
  };
  const dist = resolve(cli.cwd, options.dist);
  const { config, entries } = await readDist(dist, options, cli.log);
  const generateUploadUrls = (count: number) =>
    runComponent(
      cli,
      target,
      internal.lib.generateUploadUrls,
      { count },
      z.array(z.string()).length(count),
    );

  if (!(await hasComponent(cli, target))) {
    const missing = `The component "${options.component}" is not installed`;
    if (mode === "afterPush") throw new Error(`${missing} after the push.`);
    writeVersionFile(cli, versionId);
    if (mode === "deploy") {
      writeStateFile(cli, FIRST_INSTALL_MARKER, "");
      cli.log(`${missing} yet. The push installs it, and the upload runs after the push.`);
      return;
    }
    cli.log(`${missing} yet. Wrote ${VERSION_FILE}: npx convex dev now pushes the component.`);
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_MS));
      if (await hasComponent(cli, target)) break;
      if (Date.now() >= deadline) {
        throw new Error(`${missing}: npx convex dev did not push it in 2 minutes.`);
      }
    }
  }

  cli.log(`Uploading version ${versionId}: ${entries.length} files.`);
  const [configUrl] = await generateUploadUrls(1);
  const configId = await store(cli, configUrl, JSON.stringify(config), "application/json");
  await runComponent(cli, target, internal.lib.createVersion, { versionId, configId }, z.null());

  // Entries with the same bytes share one stored file.
  const groups = new Map<string, DistEntry[]>();
  for (const entry of entries) {
    groups.set(entry.sha256, [...(groups.get(entry.sha256) ?? []), entry]);
  }
  /** Sends the complete entries of stored files, in batches that fit a command line. */
  const record = async (stored: { sha256: string; storageId: Id<"_storage"> }[]) => {
    const complete = stored.flatMap(({ sha256, storageId }) =>
      (groups.get(sha256) ?? []).map(({ path, contentType }) => ({
        path,
        sha256,
        contentType,
        storageId,
      })),
    );
    for (const chunk of chunkByLength(complete)) {
      await runComponent(
        cli,
        target,
        internal.lib.recordFiles,
        { versionId, entries: chunk },
        z.null(),
      );
    }
  };

  // A page of uploads can take longer than the lock lives without a call.
  await withHeartbeat(cli, target, versionId, async () => {
    // Files that an entry of any version has keep their stored file.
    const known = new Set<string>();
    for (const sha256s of chunkByLength([...groups.keys()])) {
      const files = await runComponent(
        cli,
        target,
        internal.lib.knownFiles,
        { sha256s },
        z.array(z.object({ sha256: z.string(), storageId: storageIdSchema })),
      );
      for (const { sha256 } of files) known.add(sha256);
      await record(files);
    }
    const unknown = [...groups.values()].filter((group) => !known.has(group[0].sha256));
    for (let start = 0; start < unknown.length; start += UPLOAD_PAGE) {
      const page = unknown.slice(start, start + UPLOAD_PAGE);
      const urls = await generateUploadUrls(page.length);
      const uploaded: { sha256: string; storageId: Id<"_storage"> }[] = [];
      let next = 0;
      const worker = async () => {
        while (next < page.length) {
          const index = next++;
          const [{ sha256, contentType, file }] = page[index];
          const storageId = await store(cli, urls[index], readFileSync(file), contentType);
          uploaded.push({ sha256, storageId });
        }
      };
      await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
      await record(uploaded);
    }
    await runComponent(cli, target, internal.lib.finishVersion, { versionId }, z.null());
  });
  writeVersionFile(cli, versionId);
  cli.log(`Uploaded version ${versionId} and wrote ${VERSION_FILE}.`);
  if (mode === "user") {
    await runComponent(
      cli,
      target,
      internal.lib.finishDeploy,
      { versionId, pushed: true },
      z.null(),
    );
  }
}

/**
 * Runs `work` and calls `heartbeat` every 30 seconds meanwhile, so the lock means that the process
 * is alive. A heartbeat is best effort and its errors are ignored: before `createVersion` takes the
 * lock, and on a first install before the component exists, it fails, and a deploy that lost its
 * lock fails at its next call.
 */
async function withHeartbeat<T>(
  cli: Cli,
  target: Target,
  versionId: string,
  work: () => Promise<T>,
): Promise<T> {
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    heartbeat ??= runComponent(cli, target, internal.lib.heartbeat, { versionId }, z.null()).then(
      () => (heartbeat = undefined),
      () => (heartbeat = undefined),
    );
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
}

function writeVersionFile(cli: Cli, versionId: string) {
  writeStateFile(cli, VERSION_FILE, `export const versionId = ${JSON.stringify(versionId)};\n`);
}

/** Writes a file of the state folder, and the folder's `.gitignore` when it is absent. */
function writeStateFile(cli: Cli, path: string, body: string) {
  const gitignore = join(cli.cwd, STATE_DIR, ".gitignore");
  if (!existsSync(gitignore)) {
    mkdirSync(join(cli.cwd, STATE_DIR), { recursive: true });
    writeFileSync(gitignore, "*\n");
  }
  writeFileSync(join(cli.cwd, path), body);
}

/** Stores one file through an upload URL and returns its storage id. */
async function store(
  cli: Cli,
  url: string,
  body: string | Uint8Array<ArrayBuffer>,
  contentType: string | undefined,
): Promise<Id<"_storage">> {
  const response = await cli.fetch(url, {
    method: "POST",
    headers: contentType === undefined ? {} : { "Content-Type": contentType },
    body,
  });
  if (!response.ok) {
    throw new Error(`Storing a file failed with ${response.status}: ${await response.text()}`);
  }
  return z.object({ storageId: storageIdSchema }).parse(await response.json()).storageId;
}

/**
 * A storage id that an upload URL answers with, the documented source of an `Id<"_storage">`, or
 * that `knownFiles` returns. At runtime an id is a string, and its table exists only in its type,
 * so the narrowest honest check here is that it is a string; the `v.id("_storage")` validators of
 * `createVersion` and `recordFiles` check the table on the server.
 */
const storageIdSchema = z.custom<Id<"_storage">>((value) => typeof value === "string");

function chunkByLength<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let length = 0;
  for (const item of items) {
    const itemLength = JSON.stringify(item).length + 1;
    if (chunk.length > 0 && length + itemLength > MAX_ARGUMENT_LENGTH) {
      chunks.push(chunk);
      chunk = [];
      length = 0;
    }
    chunk.push(item);
    length += itemLength;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
