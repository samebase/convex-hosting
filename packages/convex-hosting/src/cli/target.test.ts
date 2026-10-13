import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { describeTarget, readConvexEnv, resolveTarget, selectorArgs } from "./target.js";

const PROD_KEY = "prod:happy-animal-123|eyJzZWNyZXQiOiJ4In0=";
const DEV_KEY = "dev:quiet-otter-456|eyJzZWNyZXQiOiJ4In0=";
const PREVIEW_KEY = "preview:team:project|eyJzZWNyZXQiOiJ4In0=";

describe("target resolution", () => {
  test("a production deploy key selects its deployment without flags", () => {
    const target = resolveTarget({ CONVEX_DEPLOY_KEY: PROD_KEY }, null);
    expect(target).toEqual({ kind: "production", deploymentName: "happy-animal-123" });
    expect(selectorArgs(target)).toEqual([]);
    expect(describeTarget(target)).toBe("production deployment happy-animal-123");
  });

  test("the deploy key wins over CONVEX_DEPLOYMENT, as in the Convex CLI", () => {
    expect(
      resolveTarget({ CONVEX_DEPLOY_KEY: DEV_KEY, CONVEX_DEPLOYMENT: "dev:other-dog-1" }, null),
    ).toEqual({ kind: "development", deploymentName: "quiet-otter-456", source: "deploy key" });
    expect(resolveTarget({ CONVEX_DEPLOYMENT_TOKEN: PROD_KEY }, null)).toMatchObject({
      kind: "production",
    });
  });

  test("--preview-name selects a preview deployment with a preview key or a login", () => {
    for (const env of [{ CONVEX_DEPLOY_KEY: PREVIEW_KEY }, { CONVEX_DEPLOYMENT: "dev:x-1" }]) {
      const target = resolveTarget(env, "feature-x");
      expect(target).toEqual({ kind: "preview", previewName: "feature-x" });
      expect(selectorArgs(target)).toEqual(["--preview-name", "feature-x"]);
    }
  });

  test("CONVEX_DEPLOYMENT selects the development deployment", () => {
    expect(resolveTarget({ CONVEX_DEPLOYMENT: "dev:happy-animal-123" }, null)).toEqual({
      kind: "development",
      deploymentName: "happy-animal-123",
      source: "CONVEX_DEPLOYMENT",
    });
  });

  test.each([
    [{ CONVEX_DEPLOY_KEY: PROD_KEY }, "feature-x", "conflicts with the production deploy key"],
    [{ CONVEX_DEPLOY_KEY: DEV_KEY }, "feature-x", "conflicts with the development deploy key"],
    [{ CONVEX_DEPLOY_KEY: PREVIEW_KEY }, null, "pass --preview-name"],
    [{ CONVEX_DEPLOY_KEY: "project:team:project|x" }, null, 'is a "project" key'],
    [{ CONVEX_DEPLOY_KEY: "not-a-key" }, null, "is not a deploy key"],
    [{}, null, "No Convex deployment is configured"],
  ])("fails before any write for %j with --preview-name %s", (env, previewName, message) => {
    expect(() => resolveTarget(env, previewName)).toThrow(message);
  });
});

describe("readConvexEnv", () => {
  const directory = mkdtempSync(join(tmpdir(), "convex-hosting-env-"));

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("reads the process environment, then .env.local, then .env", () => {
    writeFileSync(join(directory, ".env"), "CONVEX_DEPLOYMENT=dev:from-env-1\nOTHER=env\n");
    writeFileSync(join(directory, ".env.local"), "CONVEX_DEPLOYMENT=dev:from-local-2 # team: t\n");
    vi.stubEnv("CONVEX_DEPLOY_KEY", PROD_KEY);
    vi.stubEnv("CONVEX_DEPLOYMENT", undefined);
    try {
      expect(readConvexEnv(directory)).toMatchObject({
        CONVEX_DEPLOY_KEY: PROD_KEY,
        CONVEX_DEPLOYMENT: "dev:from-local-2",
        OTHER: "env",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
