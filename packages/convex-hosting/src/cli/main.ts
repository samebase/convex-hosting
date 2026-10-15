import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { internal } from "../component/_generated/api.js";
import type { Id } from "../component/_generated/dataModel.js";
import { AssetConfigSchema } from "../workers-shared/utils/types.js";
import {
  deploymentSelector,
  probeComponent,
  runComponent,
  type Cli,
  type Destination,
  type Target,
} from "./convex.js";
import { readDist, type DistEntry, type HandlingOptions } from "./files.js";

const USAGE = `Usage:
  convex-hosting init
      Once per clone, before npx convex dev: writes .convex-hosting/version.js with no site
      version and .convex-hosting/server.js with a placeholder server entry, so convex/http.ts
      bundles. Keeps existing files, except a build's server entry whose build output is gone.
  convex-hosting deploy --build "<command>" --dist <dir> [options]
      Builds, stores the site files, and pushes the functions. The push switches the site.

Options:
  --dev                         the development deployment of this checkout, instead of production
  --preview-name <name>         the preview deployment with this name, instead of production
  --html-handling <value>       auto-trailing-slash (default), force-trailing-slash,
                                drop-trailing-slash, or none
  --not-found-handling <value>  none (default), single-page-application, or 404-page
  --component <name>            the component instance (default: hosting)
  -h, --help                    this text`;

/**
 * The CLI's state folder at the project root, like Wrangler's `.wrangler/`. It holds its own
 * `.gitignore`, so git ignores it without a line in the app's ignore file.
 */
const STATE_DIR = ".convex-hosting";

/** The file that the upload writes and the app's `convex/http.ts` imports. */
export const VERSION_FILE = join(STATE_DIR, "version.js");

/**
 * The server entry that a server-rendered app's `convex/http.ts` imports. A framework adapter's
 * Vite plugin writes it after a server build; `init` writes a placeholder before the first one.
 */
export const SERVER_FILE = join(STATE_DIR, "server.js");

/** What `init` writes as the server entry. `serveSite` calls it only for a version that exists. */
const SERVER_PLACEHOLDER = `// Written by convex-hosting init: a fresh clone pushes convex/http.ts before its first build.
export default {
  fetch: () =>
    new Response("The site is not built yet.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    }),
};
`;

/**
 * The inner `upload` of a first install writes this file when the component is not installed yet.
 * `deploy` then uploads after the push.
 */
const FIRST_INSTALL_MARKER = join(STATE_DIR, "first-install");

/**
 * The version that `init` writes. Deploys name versions with random UUIDs, so no version has this
 * id, and `serveAsset` answers 404 naming it until the first deploy writes a real one.
 */
const NOT_DEPLOYED = "not-deployed";

/** Files that the upload sends to storage at once. */
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
  destination: Destination;
};

type Command =
  | { name: "help" }
  | { name: "init" }
  | { name: "deploy"; build: string; options: Options }
  | { name: "upload"; versionId: string; options: Options };

function parseCommand(args: string[]): Command {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      build: { type: "string" },
      dist: { type: "string" },
      dev: { type: "boolean", default: false },
      "preview-name": { type: "string" },
      "html-handling": { type: "string", default: "auto-trailing-slash" },
      "not-found-handling": { type: "string", default: "none" },
      component: { type: "string", default: "hosting" },
      "version-id": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (args.length === 0 || values.help) return { name: "help" };
  const [name, ...rest] = positionals;
  if (name === "init") {
    const deployOption =
      values.dist ?? values.build ?? values["version-id"] ?? values["preview-name"];
    if (rest.length > 0 || deployOption !== undefined || values.dev) throw new Error(USAGE);
    return { name };
  }
  if ((name !== "deploy" && name !== "upload") || rest.length > 0) throw new Error(USAGE);
  if (values.dist === undefined) throw new Error(`--dist is required.\n\n${USAGE}`);
  if (values.dev && values["preview-name"] !== undefined) {
    throw new Error("--dev and --preview-name exclude each other.");
  }
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
    destination: values.dev
      ? { kind: "dev" }
      : values["preview-name"] === undefined
        ? { kind: "production" }
        : { kind: "preview", name: values["preview-name"] },
  };
  // `upload` is the step that `deploy` runs inside `npx convex deploy --cmd`, after the build.
  if (name === "upload") {
    if (values["version-id"] === undefined || values.build !== undefined || values.dev) {
      throw new Error(USAGE);
    }
    return { name, versionId: values["version-id"], options };
  }
  if (values.build === undefined) throw new Error(`--build is required.\n\n${USAGE}`);
  if (values["version-id"] !== undefined) throw new Error(USAGE);
  return { name, build: values.build, options };
}

/** Runs one `convex-hosting` command and returns the exit code. */
export async function main(args: string[], cli: Cli): Promise<number> {
  try {
    const command = parseCommand(args);
    if (command.name === "help") {
      cli.log(USAGE);
    } else if (command.name === "init") {
      init(cli);
    } else if (command.name === "deploy") {
      await deploy(cli, command.options, command.build);
    } else {
      await uploadInsideDeploy(cli, command.options, command.versionId);
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

/**
 * Builds, uploads, writes the version file, and pushes. The push is the switch, and the command
 * ends: the first request that the new code serves marks its version live.
 */
async function deploy(cli: Cli, options: Options, build: string) {
  const target: Target = {
    component: options.component,
    flags: deploymentSelector(cli, options.destination),
  };
  const versionId = randomUUID();
  if (options.destination.kind === "dev") {
    await deployDev(cli, options, target, versionId, build);
  } else {
    await deployWithConvexDeploy(cli, options, target, versionId, build);
  }
  cli.log(`Deployed version ${versionId}.`);
}

/**
 * The development deployment, in one process. The build runs as a child of this process in the
 * project directory: the framework reads the deployment's URL from `.env.local` itself (Vite reads
 * `VITE_CONVEX_URL`). Then the upload runs here, and `npx convex run --push` pushes, with an inline
 * query at the app's root, which exists before the push installs the component. It works whether
 * or not `npx convex dev` runs; `npx convex dev --once` refuses while it runs a local deployment's
 * backend.
 */
async function deployDev(
  cli: Cli,
  options: Options,
  target: Target,
  versionId: string,
  build: string,
) {
  const buildExitCode = await cli.shell(build);
  if (buildExitCode !== 0) throw new Error(`The build failed with exit code ${buildExitCode}.`);
  const missing = await upload(cli, options, target, versionId);
  if (missing !== undefined) cli.log(notInstalledYet(options.component));
  const exitCode = await cli.convexInherited(["run", "--push", "--inline-query", "null"]);
  if (exitCode !== 0) throw new Error(`npx convex run --push failed with exit code ${exitCode}.`);
  if (missing !== undefined) await uploadAfterPush(cli, options, target, versionId);
}

/** Production or a preview: the build and the upload run inside `npx convex deploy --cmd`. */
async function deployWithConvexDeploy(
  cli: Cli,
  options: Options,
  target: Target,
  versionId: string,
  build: string,
) {
  const marker = join(cli.cwd, FIRST_INSTALL_MARKER);
  rmSync(marker, { force: true });
  // `npx convex deploy` goes to production by default and has no `--prod` flag.
  const deployFlags = target.flags.filter((flag) => flag !== "--prod");
  const previewFlags =
    options.destination.kind === "preview" ? ["--preview-name", options.destination.name] : [];
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
  const exitCode = await cli.convexInherited([
    "deploy",
    "--cmd",
    `${build} && ${innerUpload}`,
    ...deployFlags,
  ]);
  const firstInstall = existsSync(marker);
  rmSync(marker, { force: true });
  if (exitCode !== 0) throw new Error(`npx convex deploy failed with exit code ${exitCode}.`);
  if (firstInstall) await uploadAfterPush(cli, options, target, versionId);
}

/** The upload inside `npx convex deploy --cmd`. On a first install, `deploy` uploads after the push. */
async function uploadInsideDeploy(cli: Cli, options: Options, versionId: string) {
  const target: Target = {
    component: options.component,
    flags: deploymentSelector(cli, options.destination),
  };
  if ((await upload(cli, options, target, versionId)) !== undefined) {
    writeStateFile(cli, FIRST_INSTALL_MARKER, "");
    cli.log(notInstalledYet(options.component));
  }
}

function notInstalledYet(component: string) {
  return `The component "${component}" is not installed yet. The push installs it, and the upload runs after the push.`;
}

/** The upload of a first install, after the push. The probe's output shows a mistyped `--component`. */
async function uploadAfterPush(cli: Cli, options: Options, target: Target, versionId: string) {
  const missing = await upload(cli, options, target, versionId);
  if (missing !== undefined) {
    throw new Error(
      `The component "${options.component}" is not installed after the push. The Convex CLI ` +
        `said:\n${missing}`,
    );
  }
}

/**
 * Uploads `--dist` as version `versionId` and writes the version file. When the component is not
 * installed yet, it writes only the version file, so that the push that follows installs the
 * component, and returns the probe's output.
 */
async function upload(
  cli: Cli,
  options: Options,
  target: Target,
  versionId: string,
): Promise<string | undefined> {
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

  const missing = await probeComponent(cli, target);
  if (missing !== undefined) {
    writeVersionFile(cli, versionId);
    return missing;
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
  writeVersionFile(cli, versionId);
  cli.log(`Uploaded version ${versionId} and wrote ${VERSION_FILE}.`);
  return undefined;
}

/**
 * Makes a fresh clone bundle: `convex/http.ts` imports `.convex-hosting/version.js`, which only a
 * deploy writes, and in a server-rendered app `.convex-hosting/server.js`, which only a build
 * writes. Keeps an existing file, which names the version that this checkout last deployed or the
 * server entry of its last build. The one exception is an adapter's re-export whose target is gone,
 * for example after `dist/` was deleted: `convex/http.ts` cannot bundle through it, so `init`
 * writes the placeholder again.
 */
function init(cli: Cli) {
  if (existsSync(join(cli.cwd, VERSION_FILE))) {
    cli.log(`${VERSION_FILE} exists. Kept it.`);
  } else {
    writeVersionFile(cli, NOT_DEPLOYED);
    cli.log(
      `Wrote ${VERSION_FILE} with no site version. ` +
        "The site answers 404 until the first convex-hosting deploy.",
    );
  }
  const serverFile = join(cli.cwd, SERVER_FILE);
  if (!existsSync(serverFile)) {
    writeStateFile(cli, SERVER_FILE, SERVER_PLACEHOLDER);
    cli.log(`Wrote ${SERVER_FILE} with a placeholder server entry until the first build.`);
    return;
  }
  const target = adapterReExportTarget(readFileSync(serverFile, "utf8"));
  if (target !== undefined && !existsSync(resolve(dirname(serverFile), target))) {
    writeStateFile(cli, SERVER_FILE, SERVER_PLACEHOLDER);
    cli.log(
      `${SERVER_FILE} re-exported ${target}, which is gone. ` +
        "Wrote the placeholder server entry, which answers until the next build.",
    );
  } else {
    cli.log(`${SERVER_FILE} exists. Kept it.`);
  }
}

/**
 * The relative path that a server entry re-exports, when a framework adapter's Vite plugin wrote
 * it: one `export { default } from "<relative path>";` line, with only comment lines around it.
 * Undefined for anything else, such as the placeholder or an entry written by hand, which `init`
 * keeps. The writer is `convexSsr()` in `packages/convex-hosting-tanstack-start/src/vite.ts`; a
 * change to its format must keep this match.
 */
export function adapterReExportTarget(source: string): string | undefined {
  const code = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
  if (code.length !== 1) return undefined;
  return /^export \{ default \} from "(\.\.?\/[^"\\]+)";$/.exec(code[0])?.[1];
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
