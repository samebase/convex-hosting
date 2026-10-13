import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { UploadOptions } from "./args.js";
import { fakeCli, writeDist } from "./fakeCli.test.helpers.js";
import { sha256Hex, VERSION_ID_PATTERN } from "./manifest.js";
import type { Target } from "./target.js";
import { upload } from "./upload.js";

const preview: Target = { kind: "preview", previewName: "feature-x" };
const production: Target = { kind: "production", deploymentName: "happy-animal-123" };

let dist = "";

function options(overrides: Partial<UploadOptions> = {}): UploadOptions {
  return {
    dist,
    component: "hosting",
    previewName: null,
    immutable: "vite",
    htmlHandling: "auto-trailing-slash",
    notFoundHandling: "none",
    basePath: "/",
    versionId: null,
    activate: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dist = writeDist({
    "index.html": "<p>hi</p>",
    "assets/app.js": "console.log(1)",
    "assets/app.css": "p{}",
    _redirects: "/old /new 301\n",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dist, { recursive: true, force: true });
});

/** The version ID of every `startVersion` call, in order. */
function startedVersions(fake: ReturnType<typeof fakeCli>) {
  return fake.runs.filter((run) => run.fn === "lib:startVersion").map((run) => run.args.versionId);
}

describe("upload", () => {
  test("uploads the manifest, then each pending file, then activates", async () => {
    const fake = fakeCli();

    await upload(preview, options(), fake.cli);

    const [versionId] = startedVersions(fake);
    expect(versionId).toMatch(VERSION_ID_PATTERN);
    expect(fake.calls.slice(0, 3)).toEqual([
      "lib:generateUploadUrl",
      "fetch POST https://upload.test/1",
      "lib:startVersion",
    ]);
    expect(fake.calls.slice(-2)).toEqual(["lib:finishVersion", "lib:activate"]);
    expect(fake.calls.filter((call) => call === "lib:recordFile")).toHaveLength(3);
    expect(fake.calls.filter((call) => call.startsWith("fetch POST"))).toHaveLength(4);

    // One selector for every call: the component and the target deployment.
    for (const { argv } of fake.runs) {
      expect(argv.slice(0, 3)).toEqual(["run", "--component", "hosting"]);
      expect(argv.slice(5)).toEqual([
        "--typecheck=disable",
        "--codegen=disable",
        "--preview-name",
        "feature-x",
      ]);
    }

    const manifestBlob = fake.blobs.get("storage1");
    expect(manifestBlob?.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(manifestBlob?.bytes))).toEqual({
      versionId,
      config: {
        compatibility_date: "2025-04-01",
        html_handling: "auto-trailing-slash",
        not_found_handling: "none",
        base_path: "/",
        redirects: {
          version: 1,
          staticRules: { "/old": { status: 301, to: "/new", lineNumber: 1 } },
          rules: {},
        },
      },
      entries: [
        {
          path: "/assets/app.css",
          sha256: sha256Hex("p{}"),
          size: 3,
          contentType: "text/css; charset=utf-8",
          immutable: true,
        },
        {
          path: "/assets/app.js",
          sha256: sha256Hex("console.log(1)"),
          size: 14,
          contentType: "text/javascript; charset=utf-8",
          immutable: true,
        },
        {
          path: "/index.html",
          sha256: sha256Hex("<p>hi</p>"),
          size: 9,
          contentType: "text/html; charset=utf-8",
          immutable: false,
        },
      ],
    });
    expect(fake.runs.find((run) => run.fn === "lib:startVersion")?.args).toEqual({
      versionId,
      manifestStorageId: "storage1",
    });
    expect(fake.runs[fake.runs.length - 1]?.args).toEqual({ versionId, afterCodePush: false });
    const html = [...fake.blobs.values()].find((blob) => blob.contentType.startsWith("text/html"));
    expect(new TextDecoder().decode(html?.bytes)).toBe("<p>hi</p>");
  });

  test("--component names the instance; --no-activate leaves the live version", async () => {
    const fake = fakeCli();

    await upload(production, options({ component: "site", activate: false }), fake.cli);

    expect(fake.calls).not.toContain("lib:activate");
    expect(fake.calls[fake.calls.length - 1]).toBe("lib:finishVersion");
    expect(fake.runs[0].argv).toEqual([
      "run",
      "--component",
      "site",
      "lib:generateUploadUrl",
      "{}",
      "--typecheck=disable",
      "--codegen=disable",
    ]);
  });

  test("an empty build is a version without files", async () => {
    rmSync(dist, { recursive: true, force: true });
    dist = writeDist({});
    const fake = fakeCli();

    await upload(production, options(), fake.cli);

    expect(fake.calls).toEqual([
      "lib:generateUploadUrl",
      "fetch POST https://upload.test/1",
      "lib:startVersion",
      "lib:finishVersion",
      "lib:activate",
    ]);
  });

  test("a rerun continues the same version and uploads only what is missing", async () => {
    const fake = fakeCli();
    const recordFile = fake.functions["lib:recordFile"];
    fake.functions["lib:recordFile"] = (args) => {
      if (args.path === "/index.html") throw new Error("connection reset");
      return recordFile(args);
    };
    await expect(upload(production, options(), fake.cli)).rejects.toThrow("connection reset");
    fake.functions["lib:recordFile"] = recordFile;
    fake.runs.length = 0;

    await upload(production, options(), fake.cli);

    const recorded = fake.runs.filter((run) => run.fn === "lib:recordFile");
    expect(recorded.map((run) => run.args.path)).toEqual(["/index.html"]);
    expect(recorded[0].args.versionId).toBe(startedVersions(fake)[0]);
    expect(fake.versions.size).toBe(1);
  });

  test("a rerun of a finished version skips to activation", async () => {
    const fake = fakeCli();
    await upload(production, options({ activate: false }), fake.cli);
    fake.calls.length = 0;

    await upload(production, options(), fake.cli);

    const [first, second] = startedVersions(fake);
    expect(second).toBe(first);
    expect(fake.calls).toEqual([
      "lib:generateUploadUrl",
      "fetch POST https://upload.test/5",
      "lib:startVersion",
      "lib:activate",
    ]);
  });

  test("fails with the paths that finishVersion still reports, and a rerun uploads them", async () => {
    const fake = fakeCli();
    const recordFile = fake.functions["lib:recordFile"];
    // A success without a record: finishVersion still reports the file.
    fake.functions["lib:recordFile"] = (args) =>
      args.path === "/index.html" ? { ok: true } : recordFile(args);

    await expect(upload(production, options(), fake.cli)).rejects.toThrow(
      /Version v_[a-z2-7]{26} still has no file for \/index\.html\. Run the command again\./,
    );
    expect(fake.calls.filter((call) => call === "lib:finishVersion")).toHaveLength(1);
    expect(fake.calls).not.toContain("lib:activate");

    fake.functions["lib:recordFile"] = recordFile;
    fake.calls.length = 0;
    await upload(production, options(), fake.cli);
    expect(fake.calls.filter((call) => call === "lib:recordFile")).toHaveLength(1);
    expect(fake.calls[fake.calls.length - 1]).toBe("lib:activate");
  });

  test("a failed finishVersion tells the user to run the command again", async () => {
    const fake = fakeCli();
    fake.functions["lib:finishVersion"] = () => {
      throw new Error("Version has 2 of 3 entries");
    };

    await expect(upload(production, options(), fake.cli)).rejects.toThrow(
      /lib:finishVersion failed for version v_[a-z2-7]{26}\. Run the command again\.\nVersion has 2 of 3 entries/,
    );
  });

  test("a rejected file fails the upload with its path and the reason", async () => {
    const fake = fakeCli();
    fake.functions["lib:recordFile"] = () => ({ ok: false, reason: "sha256 mismatch" });

    await expect(upload(production, options(), fake.cli)).rejects.toThrow(
      /The component rejected \/[\w/.]+: sha256 mismatch/,
    );
    expect(fake.calls).not.toContain("lib:finishVersion");
  });
});
