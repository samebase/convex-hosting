// Deletes the Convex preview named after the closed pull request's branch, through the Convex
// management API.
import { fail, requireKey } from "../lib/steps.ts";

const key = process.env.CONVEX_DEPLOY_KEY;
if (!key) {
  console.log("No preview deleted: deploy-key is empty.");
  process.exit(0);
}
const [team, project] = requireKey("preview");
// @ts-expect-error GitHub sets GITHUB_HEAD_REF, the pull request's branch, on pull request events.
const branch: string = process.env.GITHUB_HEAD_REF;

async function api(path: string, method = "GET") {
  const response = await fetch(`https://api.convex.dev/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await response.text();
  if (!response.ok) fail(`${method} ${path}: ${response.status} ${body}`);
  return body;
}

const { id }: { id: number } = JSON.parse(await api(`teams/${team}/projects/${project}`));
const previews: { name: string; previewIdentifier: string }[] = JSON.parse(
  await api(`projects/${id}/list_deployments?deploymentType=preview`),
);
const deleted = previews.filter((preview) => preview.previewIdentifier === branch);
if (deleted.length === 0) console.log(`No preview named ${branch} in ${project}.`);
for (const { name } of deleted) {
  await api(`deployments/${name}/delete`, "POST");
  console.log(`Deleted the preview ${branch} (${name}) in ${project}.`);
}
