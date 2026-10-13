import { fileURLToPath } from "node:url";
import { z } from "zod";
import { addBasePath } from "../workers-shared/asset-worker/src/utils/base-path.js";
import { parseDeployArgs, siteOptionArgs, type DeployOptions } from "./args.js";
import { collectFiles } from "./collectFiles.js";
import { nodeCli, runComponent, type Cli } from "./commands.js";
import { findComponent, liveVersionResult } from "./componentName.js";
import { entryETag, manifestEntries, newVersionId } from "./manifest.js";
import {
  describeTarget,
  readConvexEnv,
  resolveTarget,
  selectorArgs,
  type Target,
} from "./target.js";
import { activateResult, upload } from "./upload.js";

const CLI_PATH = fileURLToPath(new URL("./index.js", import.meta.url));
const VERSION_META = /<meta\s+name=["']convex-hosting-version["']\s+content=["']([^"']*)["']/i;
const functionSpecResult = z.object({ url: z.string() });

/**
 * Releases the backend and the site to one target. When the component already answers, the files
 * upload inside `npx convex deploy --cmd`, before the push, and the version goes live after it.
 * Otherwise (first install, or an upgrade from 0.3.x) the push installs the component first.
 */
export async function deploy(target: Target, options: DeployOptions, cli: Cli): Promise<void> {
  if (target.kind === "development" && target.source === "CONVEX_DEPLOYMENT") {
    throw new Error(
      "deploy needs CONVEX_DEPLOY_KEY or --preview-name. With only CONVEX_DEPLOYMENT, " +
        "npx convex deploy pushes to production while npx convex run uses the development deployment.",
    );
  }
  console.log(`Deploying to the ${describeTarget(target)}.`);
  const versionId = newVersionId();
  const basePath = options.basePath ?? "/";
  // `npx convex deploy` adds the deployment URLs and passes this environment to `--cmd`.
  const env = {
    ...process.env,
    CONVEX_HOSTING_VERSION_ID: versionId,
    CONVEX_HOSTING_BASE_PATH: basePath,
  };

  let component = await findComponent(cli, target, options.component);
  if (component !== null) {
    const uploadCommand = commandLine([
      process.execPath,
      CLI_PATH,
      "upload",
      ...siteOptionArgs(options),
      "--component",
      component,
      ...selectorArgs(target),
      "--version-id",
      versionId,
      "--no-activate",
    ]);
    pushBackend(
      cli,
      target,
      options.buildCommand === null ? uploadCommand : `${options.buildCommand} && ${uploadCommand}`,
      env,
    );
  } else {
    console.log("The component does not answer lib:getLiveVersion. Pushing the backend first.");
    pushBackend(cli, target, options.buildCommand, env);
    component = (await upload(target, { ...options, versionId, activate: false }, cli)).component;
  }
  await runComponent(
    cli,
    target,
    component,
    "lib:activate",
    { versionId, afterCodePush: true },
    activateResult,
  );
  console.log(`Version ${versionId} is live.`);
  await verify(cli, target, component, versionId, options);
  console.log("Verified.");
}

function pushBackend(cli: Cli, target: Target, cmd: string | null, env: NodeJS.ProcessEnv): void {
  const status = cli.convexInherit(
    ["deploy", ...selectorArgs(target), ...(cmd === null ? [] : ["--cmd", cmd])],
    env,
  );
  if (status !== 0) {
    throw new Error(`npx convex deploy failed with exit status ${status}. Nothing was activated.`);
  }
}

/**
 * Checks that the deployment serves the new version: a static app (with `/index.html`) answers with
 * the new `/index.html`, a server-rendered page carries the new version meta tag, and
 * `lib:getLiveVersion` names the new version. Pages are fetched from `--site-url`, else from the
 * `.convex.site` origin of the deployment.
 */
async function verify(
  cli: Cli,
  target: Target,
  component: string,
  versionId: string,
  options: DeployOptions,
): Promise<void> {
  const basePath = options.basePath ?? "/";
  const siteUrl =
    options.siteUrl ??
    siteUrlFromCloudUrl(
      functionSpecResult.parse(
        JSON.parse(await cli.convex(["function-spec", ...selectorArgs(target)])),
      ).url,
    );
  const index = (await collectFiles(options.dist)).find((file) => file.path === "/index.html");
  if (index !== undefined) {
    const url = new URL(addBasePath("/index.html", basePath), siteUrl);
    const expected = entryETag(manifestEntries([index], () => false)[0]);
    const response = await cli.fetch(url);
    const found = response.headers.get("etag");
    // Cloudflare turns a strong ETag into a weak one when it compresses the response.
    if (response.status !== 200 || (found !== expected && found !== `W/${expected}`)) {
      throw new Error(
        `Verification failed: GET ${url} answered ${response.status} with ETag ${found ?? "(none)"}. ` +
          `Expected 200 with ETag ${expected}, the new /index.html.`,
      );
    }
  } else {
    const url = new URL(addBasePath(options.verifyPath ?? "/", basePath), siteUrl);
    const response = await cli.fetch(url);
    const found = VERSION_META.exec(await response.text())?.[1] ?? null;
    if (found !== versionId) {
      throw new Error(
        `Verification failed: GET ${url} answered ${response.status} ` +
          (found === null
            ? "without a convex-hosting-version meta tag. "
            : `with version ${found}. `) +
          `Expected <meta name="convex-hosting-version" content="${versionId}">.`,
      );
    }
  }
  const live = await runComponent(
    cli,
    target,
    component,
    "lib:getLiveVersion",
    {},
    liveVersionResult,
  );
  if (live?.versionId !== versionId) {
    throw new Error(
      `Verification failed: lib:getLiveVersion returned ${live?.versionId ?? "no live version"}. ` +
        `Expected ${versionId}.`,
    );
  }
}

/** `https://<name>.convex.cloud` serves HTTP actions at `https://<name>.convex.site`. */
export function siteUrlFromCloudUrl(cloudUrl: string): string {
  const url = new URL(cloudUrl);
  if (!url.hostname.endsWith(".convex.cloud")) {
    throw new Error(
      `Cannot verify: ${cloudUrl} is not a .convex.cloud URL, so its site URL is unknown. ` +
        "Pass the site's origin with --site-url.",
    );
  }
  url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return url.origin;
}

/** One command line for `npx convex deploy --cmd`, which runs it in `sh` or `cmd.exe`. */
export function commandLine(args: string[]): string {
  return args
    .map((arg) => {
      if (/^[\w@+=:,./-]+$/.test(arg)) return arg;
      return process.platform === "win32"
        ? `"${arg.replace(/"/g, '""')}"`
        : `'${arg.replace(/'/g, `'\\''`)}'`;
    })
    .join(" ");
}

export async function deployCommand(args: string[]): Promise<void> {
  const options = parseDeployArgs(args);
  await deploy(resolveTarget(readConvexEnv(process.cwd()), options.previewName), options, nodeCli);
}
