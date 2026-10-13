import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { DeployOptions } from "./args.js";
import { commandLine, deploy, siteUrlFromCloudUrl } from "./deploy.js";
import { fakeCli, SITE_URL, writeDist } from "./fakeCli.test.helpers.js";
import { entryETag, sha256Hex, VERSION_ID_PATTERN } from "./manifest.js";
import type { Target } from "./target.js";

const production: Target = { kind: "production", deploymentName: "happy-animal-123" };
const INDEX = "<html>v2</html>";
const INDEX_ETAG = entryETag({ sha256: sha256Hex(INDEX), contentType: "text/html; charset=utf-8" });

let dist = "";

function options(overrides: Partial<DeployOptions> = {}): DeployOptions {
  return {
    dist,
    component: null,
    previewName: null,
    immutable: "vite",
    htmlHandling: null,
    notFoundHandling: null,
    basePath: null,
    buildCommand: "npm run build",
    verifyPath: null,
    ...overrides,
  };
}

/** A fake whose component answers, and whose push marks the version that `--cmd` uploaded. */
function releasedFake() {
  const fake = fakeCli();
  fake.setLive("v_aaaaaaaaaaaaaaaaaaaaaaaaaa");
  fake.setPush((_argv, env) => {
    fake.versions.set(String(env.CONVEX_HOSTING_VERSION_ID), { state: "ready", entries: [] });
    return 0;
  });
  return fake;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dist = writeDist({ "index.html": INDEX, "assets/app.js": "1" });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dist, { recursive: true, force: true });
});

describe("deploy, when the component answers", () => {
  test("uploads inside the push, then activates and verifies", async () => {
    const fake = releasedFake();
    fake.setSite(() => new Response(INDEX, { headers: { ETag: INDEX_ETAG } }));

    await deploy(production, options(), fake.cli);

    expect(fake.calls).toEqual([
      "lib:getLiveVersion",
      "deploy",
      "lib:activate",
      "function-spec",
      `fetch GET ${SITE_URL}/index.html`,
      "lib:getLiveVersion",
    ]);
    const [{ argv, env }] = fake.pushes;
    const versionId = String(env.CONVEX_HOSTING_VERSION_ID);
    expect(versionId).toMatch(VERSION_ID_PATTERN);
    expect(env.CONVEX_HOSTING_BASE_PATH).toBe("/");
    expect(argv.slice(0, 2)).toEqual(["deploy", "--cmd"]);
    expect(argv).toHaveLength(3);
    expect(argv[2]).toMatch(/^npm run build && \S+ \S+index\.js upload /);
    expect(argv[2]).toContain(
      `upload --dist ${dist} --immutable vite --component hosting --version-id ${versionId} --no-activate`,
    );
    expect(fake.runs.find((run) => run.fn === "lib:activate")?.args).toEqual({
      versionId,
      afterCodePush: true,
    });
  });

  test("passes the preview name to the push, the upload, and every run", async () => {
    const fake = releasedFake();
    fake.setSite(() => new Response(INDEX, { headers: { ETag: `W/${INDEX_ETAG}` } }));

    await deploy(
      { kind: "preview", previewName: "feature-x" },
      options({ buildCommand: null, component: "site" }),
      fake.cli,
    );

    const [{ argv }] = fake.pushes;
    expect(argv.slice(0, 4)).toEqual(["deploy", "--preview-name", "feature-x", "--cmd"]);
    expect(argv[4]).not.toContain("npm run build");
    expect(argv[4]).toContain("--component site --preview-name feature-x --version-id");
    for (const run of fake.runs) {
      expect(run.argv.slice(1, 3)).toEqual(["--component", "site"]);
      expect(run.argv.slice(-2)).toEqual(["--preview-name", "feature-x"]);
    }
  });

  test("a failed push activates nothing", async () => {
    const fake = releasedFake();
    fake.setPush(() => 1);

    await expect(deploy(production, options(), fake.cli)).rejects.toThrow(
      "npx convex deploy failed with exit status 1. Nothing was activated.",
    );
    expect(fake.calls).toEqual(["lib:getLiveVersion", "deploy"]);
  });
});

describe("deploy, on a first install or from 0.3.x", () => {
  test("pushes the build first, then uploads, activates, and verifies", async () => {
    const fake = fakeCli();
    const getLiveVersion = fake.functions["lib:getLiveVersion"];
    let pushed = false;
    fake.functions["lib:getLiveVersion"] = (args) => {
      if (!pushed) throw new Error("Could not find function lib:getLiveVersion");
      return getLiveVersion(args);
    };
    fake.setPush(() => {
      pushed = true;
      return 0;
    });
    fake.setSite(() => new Response(INDEX, { headers: { ETag: INDEX_ETAG } }));

    await deploy(production, options(), fake.cli);

    expect(fake.calls.slice(0, 7)).toEqual([
      "lib:getLiveVersion",
      "lib:getLiveVersion",
      "deploy",
      "lib:getLiveVersion",
      "lib:generateUploadUrl",
      "fetch POST https://upload.test/1",
      "lib:startVersion",
    ]);
    expect(fake.calls.slice(-5)).toEqual([
      "lib:finishVersion",
      "lib:activate",
      "function-spec",
      `fetch GET ${SITE_URL}/index.html`,
      "lib:getLiveVersion",
    ]);
    const [{ argv, env }] = fake.pushes;
    expect(argv).toEqual(["deploy", "--cmd", "npm run build"]);
    const versionId = String(env.CONVEX_HOSTING_VERSION_ID);
    expect(fake.runs.find((run) => run.fn === "lib:startVersion")?.args.versionId).toBe(versionId);
    expect(fake.runs.filter((run) => run.fn === "lib:activate").map((run) => run.args)).toEqual([
      { versionId, afterCodePush: true },
    ]);
  });
});

describe("deploy verification", () => {
  test("a static app needs the new /index.html ETag under the base path", async () => {
    const fake = releasedFake();
    fake.setSite(() => new Response("old", { headers: { ETag: '"old-etag"' } }));

    await expect(deploy(production, options({ basePath: "/app/" }), fake.cli)).rejects.toThrow(
      `Verification failed: GET ${SITE_URL}/app/index.html answered 200 with ETag "old-etag". ` +
        `Expected 200 with ETag ${INDEX_ETAG}, the new /index.html.`,
    );
    expect(fake.pushes[0].env.CONVEX_HOSTING_BASE_PATH).toBe("/app/");
  });

  test("a server-rendered page needs the new version meta tag", async () => {
    rmSync(dist, { recursive: true, force: true });
    dist = writeDist({ "assets/app.js": "1" });
    const fake = releasedFake();
    const fetched: string[] = [];
    fake.setSite((url) => {
      fetched.push(url);
      const versionId = fake.pushes[fake.pushes.length - 1].env.CONVEX_HOSTING_VERSION_ID;
      return new Response(
        `<head><meta name="convex-hosting-version" content="${versionId}"></head>`,
      );
    });

    await deploy(production, options({ basePath: "/app/" }), fake.cli);
    await deploy(production, options({ verifyPath: "/about" }), fake.cli);

    expect(fetched).toEqual([`${SITE_URL}/app/`, `${SITE_URL}/about`]);
  });

  test("a stale page names the version it found", async () => {
    rmSync(dist, { recursive: true, force: true });
    dist = writeDist({ "assets/app.js": "1" });
    const fake = releasedFake();
    fake.setSite(
      () => new Response('<meta name="convex-hosting-version" content="v_old">', { status: 200 }),
    );

    await expect(deploy(production, options(), fake.cli)).rejects.toThrow(
      /answered 200 with version v_old\. Expected <meta name="convex-hosting-version" content="v_[a-z2-7]{26}">/,
    );

    fake.setSite(() => new Response("<p>no tag</p>"));
    await expect(deploy(production, options(), fake.cli)).rejects.toThrow(
      "without a convex-hosting-version meta tag",
    );
  });

  test("getLiveVersion must name the new version", async () => {
    const fake = releasedFake();
    fake.setSite(() => new Response(INDEX, { headers: { ETag: INDEX_ETAG } }));
    fake.functions["lib:activate"] = () => ({ previousVersionId: null });

    await expect(deploy(production, options(), fake.cli)).rejects.toThrow(
      /lib:getLiveVersion returned v_a{26}\. Expected v_[a-z2-7]{26}\./,
    );
  });
});

describe("deploy target", () => {
  test("fails before any call with only CONVEX_DEPLOYMENT", async () => {
    const fake = fakeCli();
    await expect(
      deploy(
        { kind: "development", deploymentName: "happy-animal-123", source: "CONVEX_DEPLOYMENT" },
        options(),
        fake.cli,
      ),
    ).rejects.toThrow("deploy needs CONVEX_DEPLOY_KEY or --preview-name");
    expect(fake.calls).toEqual([]);
  });
});

describe("deploy helpers", () => {
  test("the site URL is the .convex.site host of the deployment", () => {
    expect(siteUrlFromCloudUrl("https://happy-animal-123.convex.cloud")).toBe(SITE_URL);
    expect(siteUrlFromCloudUrl("https://happy-animal-123.eu-west-1.convex.cloud/")).toBe(
      "https://happy-animal-123.eu-west-1.convex.site",
    );
    expect(() => siteUrlFromCloudUrl("https://api.example.com")).toThrow("not a .convex.cloud URL");
  });

  test("quotes what the shell would change", () => {
    expect(commandLine(["/usr/bin/node", "--immutable", "/assets/**", "my dist", "it's"])).toBe(
      `/usr/bin/node --immutable '/assets/**' 'my dist' 'it'\\''s'`,
    );
  });
});
