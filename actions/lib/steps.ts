// The steps that actions/deploy, actions/preview, and actions/cleanup share. Each action's main.ts
// calls the ones it needs; the action's step puts its deploy-key in CONVEX_DEPLOY_KEY.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Ends the step with an error annotation. */
export function fail(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

/**
 * The parts of deploy-key after its kind, which must be `kind`: `prod:<deployment>|...` gives the
 * deployment, and `preview:<team>:<project>|...` the team and the project.
 */
export function requireKey(kind: "prod" | "preview"): string[] {
  const [keyKind, ...parts] = (process.env.CONVEX_DEPLOY_KEY ?? "").split("|")[0].split(":");
  if (keyKind !== kind) {
    fail(`deploy-key is empty or is not a ${kind}: deploy key. Convex was not changed.`);
  }
  return parts;
}

/**
 * Fails unless the checkout is the head of `branch`, as `git ls-remote` reads it with the job token
 * in GITHUB_TOKEN: a re-run of an old run, or a checkout of another commit, must not put older code
 * over newer code. The token goes no further, so the app's deploy script does not get it.
 */
export function requireHeadCheckout(branch: string) {
  const auth = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64");
  delete process.env.GITHUB_TOKEN;
  const [head] = execFileSync("git", ["ls-remote", "origin", `refs/heads/${branch}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
    },
  }).split("\t");
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== head) {
    fail(
      `The checkout is not the head of ${branch} (${head}): check out the head commit. Convex was not deployed.`,
    );
  }
}

/**
 * Runs the `deploy` script of the app's package.json, or `convex deploy` when there is none, with
 * `args`, then reads the deployment's two URLs with the same arguments. The URLs are empty, with a
 * warning, when the key may not run inline queries.
 */
export function deployAndReadUrls(args: string[]): { url: string; deploymentUrl: string } {
  // The app's own Convex CLI, run with node: Windows cannot spawn the npx shim without a shell.
  const convex = join(
    dirname(createRequire(join(process.cwd(), "package.json")).resolve("convex/package.json")),
    "bin",
    "main.js",
  );
  const { scripts }: { scripts?: { deploy?: string } } = JSON.parse(
    readFileSync("package.json", "utf8"),
  );
  // node --run puts node_modules/.bin on PATH and appends the arguments to the script's last command.
  const command = scripts?.deploy ? ["--run", "deploy", "--"] : [convex, "deploy"];
  const { status } = spawnSync(process.execPath, [...command, ...args], { stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);

  // The deployment's own URLs are right in every region.
  const query = spawnSync(
    process.execPath,
    [
      convex,
      "run",
      "--inline-query",
      "[process.env.CONVEX_SITE_URL, process.env.CONVEX_CLOUD_URL]",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (query.status !== 0) {
    console.log(
      "::warning::Convex is deployed, but the key cannot run the inline query that reads the deployment's URLs (deployment:functions:runTestQuery), so url and deployment-url are empty.",
    );
  }
  const [url = "", deploymentUrl = ""]: string[] =
    query.status === 0 ? JSON.parse(query.stdout) : [];
  return { url, deploymentUrl };
}

/** Writes the step's outputs, and the three links to the job summary. */
export function writeOutputs(outputs: {
  url: string;
  "deployment-url": string;
  "dashboard-url": string;
  "preview-name"?: string;
}) {
  appendFileSync(
    // @ts-expect-error GitHub sets GITHUB_OUTPUT in every step.
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  appendFileSync(
    // @ts-expect-error GitHub sets GITHUB_STEP_SUMMARY in every step.
    process.env.GITHUB_STEP_SUMMARY,
    `- Site: ${outputs.url || "unknown"}\n- Deployment: ${outputs["deployment-url"] || "unknown"}\n- Dashboard: ${outputs["dashboard-url"] || "unknown"}\n`,
  );
}
