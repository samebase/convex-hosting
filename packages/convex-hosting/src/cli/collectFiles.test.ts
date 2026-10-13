import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { checkUploadLimits, collectFiles, MAX_FILES } from "./collectFiles.js";
import { writeDist } from "./fakeCli.test.helpers.js";

describe("collectFiles", () => {
  let dist = "";

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  test("applies .assetsignore and the built-in ignores", async () => {
    dist = writeDist({
      "index.html": "",
      "assets/app.js": "",
      _headers: "",
      _redirects: "",
      "docs/_headers": "",
      ".assetsignore": "*.map\nprivate/\n",
      "assets/app.js.map": "",
      "private/notes.txt": "",
      ".env": "",
      ".git/config": "",
      "assets/.DS_Store": "",
      ".convex-hosting/version.json": "{}",
      ".well-known/security.txt": "",
      ".well-known/.hidden": "",
    });

    const files = await collectFiles(dist);

    expect(files.map((file) => file.path)).toEqual([
      "/.well-known/security.txt",
      "/assets/app.js",
      "/docs/_headers",
      "/index.html",
    ]);
  });

  // Windows needs a privilege or developer mode for symbolic links.
  test.skipIf(process.platform === "win32")(
    "never reads an ignored directory, and skips a link that does not resolve",
    async () => {
      dist = writeDist({ "index.html": "", ".assetsignore": "node_modules/\nlinked-*\n" });
      const ignored = join(dist, "node_modules");
      mkdirSync(ignored);
      symlinkSync(join(dist, "missing"), join(ignored, "dangling"));
      symlinkSync(join(dist, "missing"), join(dist, "linked-dangling"));
      symlinkSync(join(dist, "missing"), join(dist, "dangling.js"));
      symlinkSync(join(dist, "index.html"), join(dist, "page.html"));
      // Reading the ignored directory now fails (for a user that is not root).
      chmodSync(ignored, 0o000);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const files = await collectFiles(dist);

        expect(files.map((file) => file.path)).toEqual(["/index.html", "/page.html"]);
        expect(warn.mock.calls).toEqual([
          ["Skipped /dangling.js: the symbolic link does not resolve."],
        ]);
      } finally {
        warn.mockRestore();
        chmodSync(ignored, 0o755);
      }
    },
  );

  test("records each file's size", async () => {
    dist = writeDist({ "index.html": "<p>hello</p>" });
    expect(await collectFiles(dist)).toEqual([
      expect.objectContaining({ path: "/index.html", size: 12 }),
    ]);
  });
});

describe("upload limits", () => {
  test("a version holds 0 to 4,000 files", () => {
    const file = (index: number) => ({ path: `/${index}.js`, size: 1 });
    expect(() => checkUploadLimits("dist", [])).not.toThrow();
    expect(() =>
      checkUploadLimits(
        "dist",
        Array.from({ length: MAX_FILES }, (_, index) => file(index)),
      ),
    ).not.toThrow();
    expect(() =>
      checkUploadLimits(
        "dist",
        Array.from({ length: MAX_FILES + 1 }, (_, index) => file(index)),
      ),
    ).toThrow("dist has 4001 files. A version holds at most 4000.");
  });

  test("a path is at most 1,024 bytes, counted in UTF-8", () => {
    expect(() =>
      checkUploadLimits("dist", [{ path: `/${"a".repeat(1023)}`, size: 1 }]),
    ).not.toThrow();
    expect(() => checkUploadLimits("dist", [{ path: `/${"é".repeat(512)}`, size: 1 }])).toThrow(
      "is 1025 bytes long",
    );
  });

  test("a file is at most 25 MiB", () => {
    const size = 25 * 1024 * 1024;
    expect(() => checkUploadLimits("dist", [{ path: "/a.bin", size }])).not.toThrow();
    expect(() => checkUploadLimits("dist", [{ path: "/a.bin", size: size + 1 }])).toThrow(
      "/a.bin is 26214401 bytes. A file is at most 25 MiB",
    );
  });
});
