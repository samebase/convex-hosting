// The steps of actions/deploy, actions/preview, and actions/cleanup. The first argument names the
// action, and CONVEX_DEPLOY_KEY holds its deploy-key. deploy and preview run in the app's directory,
// with the job token in GITHUB_TOKEN for the head check.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const key = process.env.CONVEX_DEPLOY_KEY ?? "";
// A deploy key starts with its kind: prod:<deployment>|..., or preview:<team>:<project>|...
const [kind, ...names] = key.split("|")[0].split(":");
// Unset outside a pull request.
const headRef = process.env.GITHUB_HEAD_REF ?? "";

function fail(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

/** Deploys the checkout, which must be the head of `branch`, and writes the outputs. */
function deploy(branch: string, previewName: string) {
  const auth = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64");
  // The app's deploy script does not get the job token.
  delete process.env.GITHUB_TOKEN;
  // A re-run of an old run, or a checkout of another commit, must not put older code over newer code.
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

  const args = previewName ? ["--preview-name", previewName] : [];
  const { scripts }: { scripts?: { deploy?: string } } = JSON.parse(
    readFileSync("package.json", "utf8"),
  );
  // node --run puts node_modules/.bin on PATH and appends the arguments to the script's last command.
  const [command, ...commandArgs] = scripts?.deploy
    ? ["node", "--run", "deploy", "--"]
    : ["npx", "convex", "deploy"];
  const { status } = spawnSync(command, [...commandArgs, ...args], { stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);

  // The deployment's own URLs are right in every region; a key without inline queries still deploys.
  const query = spawnSync(
    "npx",
    [
      "convex",
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
  const [url = "", cloud = ""]: string[] = query.status === 0 ? JSON.parse(query.stdout) : [];
  // A production key names its deployment; a preview's name is its .convex.cloud host's first label.
  const name = previewName
    ? /^https:\/\/([^.]+)\.(?:.+\.)?convex\.cloud$/.exec(cloud)?.[1]
    : names[0];
  const dashboard = name ? `https://dashboard.convex.dev/d/${name}` : "";
  appendFileSync(
    // @ts-expect-error GitHub sets GITHUB_OUTPUT in every step.
    process.env.GITHUB_OUTPUT,
    `url=${url}\ndeployment-url=${cloud}\ndashboard-url=${dashboard}\npreview-name=${previewName}\n`,
  );
  appendFileSync(
    // @ts-expect-error GitHub sets GITHUB_STEP_SUMMARY in every step.
    process.env.GITHUB_STEP_SUMMARY,
    `- Site: ${url || "unknown"}\n- Deployment: ${cloud || "unknown"}\n- Dashboard: ${dashboard || "unknown"}\n`,
  );
}

switch (process.argv[2]) {
  case "deploy":
    if (kind !== "prod") {
      fail(
        "deploy-key is missing or is not a production deploy key (prod:...). Convex was not deployed.",
      );
    }
    deploy(process.env.GITHUB_REF_NAME ?? "", "");
    break;

  case "preview":
    if (!key) {
      console.log("::notice::No preview: set CONVEX_PREVIEW_DEPLOY_KEY and pass it as deploy-key.");
      break;
    }
    if (kind !== "preview") {
      fail(
        "deploy-key is not a preview deploy key (preview:...). Convex was not deployed: npx convex deploy with a production key ignores --preview-name and deploys to production.",
      );
    }
    deploy(headRef, headRef);
    break;

  case "cleanup": {
    if (!key) {
      console.log("No preview deleted: deploy-key is empty.");
      break;
    }
    if (kind !== "preview") fail("deploy-key is not a preview deploy key (preview:...).");
    const [team, project] = names;
    const api = async (path: string, method = "GET") => {
      const response = await fetch(`https://api.convex.dev/v1/${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      });
      const body = await response.text();
      if (!response.ok) fail(`${method} ${path}: ${response.status} ${body}`);
      return body;
    };
    const { id }: { id: number } = JSON.parse(await api(`teams/${team}/projects/${project}`));
    const previews: { name: string; previewIdentifier: string }[] = JSON.parse(
      await api(`projects/${id}/list_deployments?deploymentType=preview`),
    );
    const deleted = previews.filter((preview) => preview.previewIdentifier === headRef);
    if (deleted.length === 0) console.log(`No preview named ${headRef} in ${project}.`);
    for (const { name } of deleted) {
      await api(`deployments/${name}/delete`, "POST");
      console.log(`Deleted the preview ${headRef} (${name}) in ${project}.`);
    }
    break;
  }
}
