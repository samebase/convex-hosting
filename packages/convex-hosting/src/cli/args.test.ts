import { describe, expect, test } from "vite-plus/test";
import { parseDeployArgs, parseUploadArgs, siteOptionArgs } from "./args.js";

describe("upload arguments", () => {
  test("defaults leave the serving modes to the entry point", () => {
    expect(parseUploadArgs(["--dist", "dist"])).toEqual({
      dist: "dist",
      component: null,
      previewName: null,
      immutable: "vite",
      htmlHandling: null,
      notFoundHandling: null,
      basePath: null,
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
  test("builds with npm run build by default", () => {
    expect(parseDeployArgs(["--dist", "dist"])).toMatchObject({
      buildCommand: "npm run build",
      verifyPath: null,
      siteUrl: null,
    });
  });

  test("the site URL is an http or https origin", () => {
    expect(
      parseDeployArgs(["--dist", "dist", "--site-url", "https://app.example.com/"]).siteUrl,
    ).toBe("https://app.example.com");
    for (const siteUrl of [
      "app.example.com",
      "ftp://app.example.com",
      "https://app.example.com/app/",
      "https://app.example.com/?x=1",
    ]) {
      expect(() => parseDeployArgs(["--dist", "dist", "--site-url", siteUrl])).toThrow(
        "--site-url must be an origin",
      );
    }
    expect(() => parseUploadArgs(["--dist", "dist", "--site-url", "https://x.test"])).toThrow(
      "Unknown option '--site-url'",
    );
  });

  test("--skip-build drops the build", () => {
    expect(parseDeployArgs(["--dist", "dist", "--skip-build"]).buildCommand).toBeNull();
    expect(() =>
      parseDeployArgs(["--dist", "dist", "--skip-build", "--build-command", "vite build"]),
    ).toThrow("cannot be combined");
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
      "--immutable",
      "next",
      "--not-found-handling",
      "404-page",
      "--base-path",
      "/app/",
    ]);
    expect(parseUploadArgs(siteOptionArgs(options))).toMatchObject({
      dist: options.dist,
      immutable: options.immutable,
      htmlHandling: options.htmlHandling,
      notFoundHandling: options.notFoundHandling,
      basePath: options.basePath,
    });
  });
});
