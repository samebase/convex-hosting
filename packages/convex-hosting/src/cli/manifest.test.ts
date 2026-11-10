import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { manifestLookup } from "../client/manifest.js";
import { buildAssetFiles, type AssetEntry } from "./manifest.js";
import { siteConfig } from "./site-config.js";

const CLOUD_URL = "https://happy-cat-123.convex.cloud";
const config = siteConfig({});
const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
const url = (key: string) =>
  `${CLOUD_URL}/api/storage/${key}?component=m026ambq8g7g5yxf42tb4d4tfx8hg303`;

/** `count` entries; every third shares the bytes of the one before, and every fifth has no type. */
function entries(count: number, paths = (i: number) => `/assets/chunk-${i}.js`): AssetEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const sha256 = sha256Hex(`body ${i - (i % 3 === 2 ? 1 : 0)}`);
    const contentType = i % 5 === 4 ? undefined : i % 2 === 0 ? "text/javascript" : "text/html";
    return { path: paths(i), sha256, contentType, url: url(sha256.slice(0, 36)) };
  });
}

describe("buildAssetFiles, read with Cloudflare's lookup", () => {
  test.each([0, 1, 2, 64, 5000])("%i entries: every path finds its URL and type", async (count) => {
    const list = entries(count);
    const lookup = manifestLookup(buildAssetFiles(CLOUD_URL, config, list));
    for (const entry of list) {
      const hit = await lookup(entry.path);
      expect(hit).toEqual({
        eTag: sha256Hex(`${entry.sha256}\n${entry.contentType ?? ""}`).slice(0, 32),
        url: entry.url,
        contentType: entry.contentType,
      });
    }
    expect(await lookup("/assets/missing.js")).toBeNull();
  });

  test("paths with Unicode, spaces, and percent signs are found as the handler decodes them", async () => {
    const paths = [
      "/café/menu.html",
      "/a b/c.txt",
      "/100%.html",
      "/日本語/索引.html",
      "/emoji/🙂.svg",
    ];
    const lookup = manifestLookup(
      buildAssetFiles(
        CLOUD_URL,
        config,
        entries(paths.length, (i) => paths[i]),
      ),
    );
    for (const path of paths) expect(await lookup(path)).not.toBeNull();
    expect(await lookup("/caf%C3%A9/menu.html")).toBeNull();
  });

  test("the same bytes under two content types share one stored file and have two ETags", async () => {
    const sha256 = sha256Hex("same");
    const files = buildAssetFiles(CLOUD_URL, config, [
      { path: "/a.txt", sha256, contentType: "text/plain", url: url("k1") },
      { path: "/a.js", sha256, contentType: "text/javascript", url: url("k1") },
    ]);
    const lookup = manifestLookup(files);
    const txt = await lookup("/a.txt");
    const js = await lookup("/a.js");
    expect(files.urls).toEqual([url("k1")]);
    expect(txt?.eTag).not.toBe(js?.eTag);
    expect([txt?.contentType, js?.contentType]).toEqual(["text/plain", "text/javascript"]);
  });
});
