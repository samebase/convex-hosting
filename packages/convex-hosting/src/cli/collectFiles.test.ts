import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { collectFiles } from "./collectFiles.js";

describe("collectFiles", () => {
  let distDir: string;

  afterEach(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  test("skips hosting rule files at the root of the build output", () => {
    distDir = mkdtempSync(join(tmpdir(), "convex-hosting-dist-"));
    mkdirSync(join(distDir, "docs"));
    for (const path of ["index.html", "_headers", "_redirects", "docs/_headers"]) {
      writeFileSync(join(distDir, path), "");
    }

    const { files, skipped } = collectFiles(distDir);

    expect(files.map((file) => file.path).sort()).toEqual(["/docs/_headers", "/index.html"]);
    expect(skipped.sort()).toEqual(["/_headers", "/_redirects"]);
  });
});
