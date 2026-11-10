import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { manifestLookup } from "../client/manifest.js";
import { buildAssetFiles, type AssetEntry } from "./manifest.js";
import { siteConfig } from "./site-config.js";

const CLOUD_URL = "https://happy-cat-123.convex.cloud";
const config = siteConfig({});
const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
const url = (key: string) =>
  `${CLOUD_URL}/api/storage/${key}?component=m026ambq8g7g5yxf42tb4d4tfx8hg303`;

/** What the lookup finds for an entry. */
const hit = (entry: AssetEntry) => ({
  eTag: sha256Hex(`${entry.sha256}\n${entry.contentType ?? ""}`).slice(0, 32),
  url: entry.url,
  contentType: entry.contentType,
});

/** A file of any path, Unicode included, whose storage key has any length. */
const anyEntry = fc.record({
  path: fc.string({ unit: "grapheme" }).map((path) => `/${path}`),
  sha256: fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) => {
    return Buffer.from(bytes).toString("hex");
  }),
  contentType: fc.option(fc.constantFrom("text/html; charset=utf-8", "text/css", "image/png"), {
    nil: undefined,
  }),
  url: fc.stringMatching(/^[0-9a-z-]{1,40}$/).map(url),
});

describe("buildAssetFiles, read with Cloudflare's lookup", () => {
  test("every path of any site finds its own entry, and any other path finds none", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(anyEntry, { selector: ({ path }) => path, maxLength: 40 }),
        fc.string({ unit: "grapheme" }).map((path) => `/${path}`),
        async (entries, other) => {
          const lookup = manifestLookup(buildAssetFiles(CLOUD_URL, config, entries));
          for (const entry of entries) expect(await lookup(entry.path)).toEqual(hit(entry));
          if (entries.every(({ path }) => path !== other)) expect(await lookup(other)).toBeNull();
        },
      ),
    );
  });

  test("5,000 entries: every path finds its entry", async () => {
    // Every third entry shares the bytes of the one before, and every fifth has no type.
    const entries = Array.from({ length: 5000 }, (_, i) => {
      const sha256 = sha256Hex(`body ${i - (i % 3 === 2 ? 1 : 0)}`);
      const contentType = i % 5 === 4 ? undefined : i % 2 === 0 ? "text/javascript" : "text/html";
      return { path: `/assets/chunk-${i}.js`, sha256, contentType, url: url(sha256.slice(0, 36)) };
    });
    const lookup = manifestLookup(buildAssetFiles(CLOUD_URL, config, entries));
    for (const entry of entries) expect(await lookup(entry.path)).toEqual(hit(entry));
    expect(await lookup("/assets/missing.js")).toBeNull();
  });

  test("a path is found as the handler decodes it, not percent-encoded", async () => {
    const entry = { path: "/café/menu.html", sha256: sha256Hex("menu"), contentType: undefined };
    const lookup = manifestLookup(
      buildAssetFiles(CLOUD_URL, config, [{ ...entry, url: url("k") }]),
    );
    expect(await lookup("/café/menu.html")).not.toBeNull();
    expect(await lookup("/caf%C3%A9/menu.html")).toBeNull();
  });

  test("the storage URLs are written as what they share and one string of keys", () => {
    const entries = ["0c1f6a52", "5b7d2e11", "9e4a7c30"].map((key, i) => ({
      path: `/${i}.js`,
      sha256: sha256Hex(key),
      contentType: undefined,
      url: url(key),
    }));
    expect(buildAssetFiles(CLOUD_URL, config, entries)).toMatchObject({
      urlPrefix: `${CLOUD_URL}/api/storage/`,
      urlSuffix: "?component=m026ambq8g7g5yxf42tb4d4tfx8hg303",
      urlKeys: "0c1f6a525b7d2e119e4a7c30",
      urlKeyWidth: 8,
    });
  });
});
