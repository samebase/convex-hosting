import { describe, expect, test } from "vite-plus/test";
import { parseDeployArgs, parseUploadArgs, siteOptionArgs } from "./args.js";

describe("upload arguments", () => {
  test("resolves every default", () => {
    expect(parseUploadArgs(["--dist", "dist"])).toEqual({
      dist: "dist",
      component: "hosting",
      previewName: null,
      immutable: "vite",
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "none",
      basePath: "/",
      versionId: null,
      activate: true,
    });
  });

  test("parses every option", () => {
    expect(
      parseUploadArgs([
        "--dist=out",
        "--component",
        "site",
        "--preview-name",
        "feature-x",
        "--immutable",
        "/static/**",
        "--html-handling",
        "none",
        "--not-found-handling",
        "single-page-application",
        "--base-path",
        "app",
        "--version-id",
        "v_abcdefghijklmnopqrstuvwxyz",
        "--no-activate",
      ]),
    ).toEqual({
      dist: "out",
      component: "site",
      previewName: "feature-x",
      immutable: "/static/**",
      htmlHandling: "none",
      notFoundHandling: "single-page-application",
      basePath: "/app/",
      versionId: "v_abcdefghijklmnopqrstuvwxyz",
      activate: false,
    });
  });

  test.each([
    [[], "--dist <dir> is required"],
    [["--dist"], "argument missing"],
    [["--dist", "--component", "x"], "ambiguous"],
    [["--dist", "dist", "--prod"], "Unknown option '--prod'"],
    [["--dist", "dist", "--cdn"], "Unknown option '--cdn'"],
    [["--dist", "dist", "extra"], "Unexpected argument 'extra'"],
    [["--dist", "dist", "--html-handling", "spa"], "--html-handling must be one of"],
    [["--dist", "dist", "--not-found-handling", "spa"], "--not-found-handling must be one of"],
    [
      ["--dist", "dist", "--base-path", "https://x.test/"],
      "--base-path: The value must be a pathname",
    ],
    [["--dist", "dist", "--version-id", "v_ABC"], "--version-id must be v_"],
  ])("rejects %j", (args, message) => {
    expect(() => parseUploadArgs(args)).toThrow(message);
  });
});

describe("deploy arguments", () => {
  test("builds with npm run build and verifies / by default", () => {
    expect(parseDeployArgs(["--dist", "dist"])).toMatchObject({
      buildCommand: "npm run build",
      verifyPath: "/",
    });
  });

  test("the verify path is absolute", () => {
    expect(parseDeployArgs(["--dist", "dist", "--verify-path", "/about"]).verifyPath).toBe(
      "/about",
    );
    expect(() => parseDeployArgs(["--dist", "dist", "--verify-path", "about"])).toThrow(
      "must start with /",
    );
  });

  test("forwards the site options to the upload subprocess exactly", () => {
    const options = parseDeployArgs([
      "--dist",
      "web dist",
      "--immutable",
      "next",
      "--not-found-handling",
      "404-page",
      "--base-path",
      "/app",
      "--build-command",
      "pnpm build",
    ]);
    expect(siteOptionArgs(options)).toEqual([
      "--dist",
      "web dist",
      "--component",
      "hosting",
      "--immutable",
      "next",
      "--html-handling",
      "auto-trailing-slash",
      "--not-found-handling",
      "404-page",
      "--base-path",
      "/app/",
    ]);
    expect(parseUploadArgs(siteOptionArgs(options))).toMatchObject({
      dist: options.dist,
      component: options.component,
      immutable: options.immutable,
      htmlHandling: options.htmlHandling,
      notFoundHandling: options.notFoundHandling,
      basePath: options.basePath,
    });
  });
});
