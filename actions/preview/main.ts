// Deploys a pull request's app to the preview named after its branch and writes its URLs to the
// step's outputs.
import { deployAndReadUrls, requireHeadCheckout, requireKey, writeOutputs } from "../lib/steps.ts";

if (!process.env.CONVEX_DEPLOY_KEY) {
  console.log("::notice::No preview: set CONVEX_PREVIEW_DEPLOY_KEY and pass it as deploy-key.");
  process.exit(0);
}
// A production key would deploy the pull request to production: npx convex deploy ignores
// --preview-name with it.
requireKey("preview");
// @ts-expect-error GitHub sets GITHUB_HEAD_REF, the pull request's branch, on pull request events.
const branch: string = process.env.GITHUB_HEAD_REF;
requireHeadCheckout(branch);
const { url, deploymentUrl } = deployAndReadUrls(["--preview-name", branch]);
// A preview's name is its .convex.cloud host's first label.
const name = /^https:\/\/([^.]+)\.(?:.+\.)?convex\.cloud$/.exec(deploymentUrl)?.[1];
writeOutputs({
  url,
  "deployment-url": deploymentUrl,
  "dashboard-url": name ? `https://dashboard.convex.dev/d/${name}` : "",
  "preview-name": branch,
});
