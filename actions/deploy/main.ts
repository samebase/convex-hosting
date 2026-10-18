// Deploys the app to production and writes its URLs to the step's outputs.
import { deployAndReadUrls, requireHeadCheckout, requireKey, writeOutputs } from "../lib/steps.ts";

const [deployment] = requireKey("prod");
// @ts-expect-error GitHub sets GITHUB_REF_NAME, the pushed branch, in every step.
requireHeadCheckout(process.env.GITHUB_REF_NAME);
const { url, deploymentUrl } = deployAndReadUrls([]);
writeOutputs({
  url,
  "deployment-url": deploymentUrl,
  "dashboard-url": `https://dashboard.convex.dev/d/${deployment}`,
});
