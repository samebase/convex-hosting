import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { collectFiles } from "./collectFiles.js";
import { writeDist } from "./fakeCli.test.helpers.js";
import {
  buildConfig,
  contentTypeFor,
  entryETag,
  immutableMatcher,
  manifestDigest,
  manifestEntries,
  newVersionId,
  resolveVersionId,
  sha256Hex,
  VERSION_ID_PATTERN,
  versionFilePath,
} from "./manifest.js";

const defaults = { htmlHandling: null, notFoundHandling: null, basePath: null };

let dist = "";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dist, { recursive: true, force: true });
});

describe("immutable classification", () => {
  test.each([
    ["vite", "/assets/index-abc.js", "/assets.js"],
    ["next", "/_next/static/chunks/a.js", "/_next/data/a.json"],
    ["astro", "/_astro/a.css", "/astro/a.css"],
    ["sveltekit", "/_app/immutable/a.js", "/_app/version.json"],
    ["/static/**", "/static/deep/a.png", "/public/static/a.png"],
  ])("%s", (setting, immutablePath, stablePath) => {
    const isImmutable = immutableMatcher(setting);
    expect(isImmutable(immutablePath)).toBe(true);
    expect(isImmutable(stablePath)).toBe(false);
    expect(isImmutable("/index.html")).toBe(false);
  });
});

describe("content types", () => {
  test.each([
    ["/index.html", "text/html; charset=utf-8"],
    ["/assets/app.js", "text/javascript; charset=utf-8"],
    ["/assets/app.css", "text/css; charset=utf-8"],
    ["/data.json", "application/json"],
    ["/logo.svg", "image/svg+xml"],
    ["/.well-known/apple-app-site-association", "application/json"],
    ["/.well-known/security.txt", "text/plain; charset=utf-8"],
    ["/LICENSE", "application/octet-stream"],
  ])("%s is %s", (path, contentType) => {
    expect(contentTypeFor(path)).toBe(contentType);
  });
});

describe("config", () => {
  test("has only the compatibility date without rule files or flags", () => {
    dist = writeDist({ "index.html": "" });
    expect(buildConfig(dist, defaults)).toEqual({ compatibility_date: "2025-04-01" });
  });

  test("carries the flags and the parsed _headers and _redirects", () => {
    dist = writeDist({
      "index.html": "",
      _headers: "/assets/*\n  X-Robots-Tag: noindex\n",
      _redirects: "/old /new 301\n/blog/* /posts/:splat\n",
    });
    expect(
      buildConfig(dist, {
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "404-page",
        basePath: "/app/",
      }),
    ).toEqual({
      compatibility_date: "2025-04-01",
      html_handling: "drop-trailing-slash",
      not_found_handling: "404-page",
      base_path: "/app/",
      headers: { version: 2, rules: { "/assets/*": { set: { "x-robots-tag": "noindex" } } } },
      redirects: {
        version: 1,
        staticRules: { "/old": { status: 301, to: "/new", lineNumber: 1 } },
        rules: { "/blog/*": { status: 302, to: "/posts/:splat" } },
      },
    });
  });

  test("fails when the rules need more than 256 KiB", () => {
    const rules = Array.from({ length: 2000 }, (_, index) => `/${index}${"x".repeat(150)} /`);
    dist = writeDist({ _redirects: rules.join("\n") });
    expect(() => buildConfig(dist, defaults)).toThrow("A version's config holds at most 262144");
  });
});

describe("manifest", () => {
  test("lists each file with its hash, size, content type, and class", async () => {
    dist = writeDist({ "index.html": "<p>hi</p>", "assets/app.js": "console.log(1)" });
    const entries = manifestEntries(await collectFiles(dist), immutableMatcher("vite"));
    expect(entries).toEqual([
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
    ]);
  });

  test("the digest changes with the files and the config, not with the version", async () => {
    dist = writeDist({ "index.html": "a" });
    const config = buildConfig(dist, defaults);
    const entries = manifestEntries(await collectFiles(dist), immutableMatcher("vite"));
    const digest = manifestDigest(config, entries);
    expect(manifestDigest(config, [...entries])).toBe(digest);
    expect(manifestDigest({ ...config, html_handling: "none" }, entries)).not.toBe(digest);
    expect(manifestDigest(config, [{ ...entries[0], sha256: sha256Hex("b") }])).not.toBe(digest);
  });

  test("the ETag is the component's entry key", () => {
    const sha256 = sha256Hex("a");
    expect(entryETag({ sha256, contentType: "text/html; charset=utf-8" })).toBe(
      `"${sha256}-${sha256Hex("text/html; charset=utf-8").slice(0, 8)}"`,
    );
  });
});

describe("version ID", () => {
  test("a new ID is v_ and 26 base32 characters", () => {
    const ids = new Set(Array.from({ length: 50 }, newVersionId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(VERSION_ID_PATTERN);
  });

  test("is reused while the digest is the same, and stored with it", () => {
    dist = writeDist({ "index.html": "" });
    const first = resolveVersionId(dist, "digest-a", null);
    expect(first).toMatch(VERSION_ID_PATTERN);
    expect(JSON.parse(readFileSync(versionFilePath(dist), "utf8"))).toEqual({
      versionId: first,
      digest: "digest-a",
    });
    expect(resolveVersionId(dist, "digest-a", null)).toBe(first);
    const second = resolveVersionId(dist, "digest-b", null);
    expect(second).not.toBe(first);
    expect(resolveVersionId(dist, "digest-a", null)).not.toBe(first);
  });

  test("an explicit ID wins and is stored", () => {
    dist = writeDist({ "index.html": "" });
    resolveVersionId(dist, "digest-a", null);
    const explicit = "v_abcdefghijklmnopqrstuvwxyz";
    expect(resolveVersionId(dist, "digest-a", explicit)).toBe(explicit);
    expect(resolveVersionId(dist, "digest-a", null)).toBe(explicit);
  });

  test("a damaged file starts a new version", () => {
    dist = writeDist({ "index.html": "", ".convex-hosting/version.json": "{" });
    expect(resolveVersionId(dist, "digest-a", null)).toMatch(VERSION_ID_PATTERN);
    writeFileSync(versionFilePath(dist), JSON.stringify({ versionId: "bad", digest: "digest-a" }));
    expect(resolveVersionId(dist, "digest-a", null)).toMatch(VERSION_ID_PATTERN);
  });
});
