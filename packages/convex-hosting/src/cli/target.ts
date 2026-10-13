import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * The one deployment that a command writes to. The Convex CLI picks a deployment from the
 * environment and its flags; every `npx convex` call of one command gets the same selector
 * (`selectorArgs`), so all of them reach this deployment.
 */
export type Target =
  | { kind: "production"; deploymentName: string }
  | { kind: "development"; deploymentName: string; source: "deploy key" | "CONVEX_DEPLOYMENT" }
  /** A named preview: with a project's preview deploy key or a login, and `--preview-name`. */
  | { kind: "preview"; previewName: string }
  /** The one preview deployment of a deployment's own preview deploy key. */
  | { kind: "preview deployment"; deploymentName: string };

export type ConvexEnv = Record<string, string | undefined>;

/**
 * The variables that the Convex CLI reads to select a deployment: the process environment first,
 * then `.env.local`, then `.env` in `directory`, the same order as `npx convex run` and
 * `npx convex deploy` in that directory.
 */
export function readConvexEnv(directory: string): ConvexEnv {
  const fromFile = (name: string) => {
    const path = join(directory, name);
    return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  };
  return { ...fromFile(".env"), ...fromFile(".env.local"), ...process.env };
}

/**
 * Resolves the target before any write. Fails when the flags and the environment disagree, because
 * the Convex CLI would then silently ignore `--preview-name` and use the deploy key's deployment.
 */
export function resolveTarget(env: ConvexEnv, previewName: string | null): Target {
  const deployKey = env.CONVEX_DEPLOY_KEY || env.CONVEX_DEPLOYMENT_TOKEN;
  if (deployKey) {
    const [prefix] = deployKey.split("|");
    const [type, ...rest] = prefix.split(":");
    if (!deployKey.includes("|")) {
      throw new Error("CONVEX_DEPLOY_KEY is not a deploy key. Copy a new one from the dashboard.");
    }
    // The Convex CLI (isPreviewDeployKey in convex/src/cli/lib/deployment.ts) tells the two preview
    // keys apart by the prefix: `preview:<team>:<project>` for a project, where `--preview-name`
    // selects or creates the named preview, and `preview:<deployment>` for one deployment, where
    // the Convex CLI ignores `--preview-name`.
    if (type === "preview" && rest.length === 2) {
      if (previewName === null) {
        throw new Error(
          "CONVEX_DEPLOY_KEY is a project's preview deploy key: pass --preview-name <name>.",
        );
      }
      return { kind: "preview", previewName };
    }
    if (type === "preview" && rest.length === 1) {
      const [deploymentName] = rest;
      if (previewName !== null) {
        throw new Error(
          `--preview-name ${previewName} conflicts with the deploy key of the preview deployment ` +
            `${deploymentName} in CONVEX_DEPLOY_KEY. Use a project's preview deploy key, or remove ` +
            "--preview-name.",
        );
      }
      return { kind: "preview deployment", deploymentName };
    }
    if (type === "preview") {
      throw new Error("CONVEX_DEPLOY_KEY is not a deploy key. Copy a new one from the dashboard.");
    }
    if (type === "prod" || type === "dev") {
      const kind = type === "prod" ? "production" : "development";
      if (previewName !== null) {
        throw new Error(
          `--preview-name ${previewName} conflicts with the ${kind} deploy key in CONVEX_DEPLOY_KEY. ` +
            "Use a preview deploy key, or remove --preview-name.",
        );
      }
      const deploymentName = rest[rest.length - 1];
      return kind === "production"
        ? { kind, deploymentName }
        : { kind, deploymentName, source: "deploy key" };
    }
    throw new Error(
      `CONVEX_DEPLOY_KEY is a "${type}" key. Use a production, development, or preview deploy key.`,
    );
  }
  if (previewName !== null) return { kind: "preview", previewName };
  if (env.CONVEX_DEPLOYMENT) {
    const deploymentName = env.CONVEX_DEPLOYMENT.split(":").pop() ?? env.CONVEX_DEPLOYMENT;
    return { kind: "development", deploymentName, source: "CONVEX_DEPLOYMENT" };
  }
  throw new Error(
    "No Convex deployment is configured. Run `npx convex dev` once, or set CONVEX_DEPLOY_KEY.",
  );
}

/** The `npx convex run`, `deploy`, and `function-spec` flags that select the target. */
export function selectorArgs(target: Target): string[] {
  // A deployment's deploy key or CONVEX_DEPLOYMENT selects the other deployments. The Convex CLI
  // ignores `--prod` next to a deploy key and rejects `--deployment`, so no flag is passed.
  return target.kind === "preview" ? ["--preview-name", target.previewName] : [];
}

export function describeTarget(target: Target): string {
  switch (target.kind) {
    case "production":
      return `production deployment ${target.deploymentName}`;
    case "development":
      return `development deployment ${target.deploymentName}`;
    case "preview":
      return `preview deployment "${target.previewName}"`;
    case "preview deployment":
      return `preview deployment ${target.deploymentName}`;
    default:
      return target satisfies never;
  }
}
