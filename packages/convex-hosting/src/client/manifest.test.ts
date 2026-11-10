import { describe, expect, test } from "vite-plus/test";
import { siteConfig } from "../cli/site-config.js";
import {
  buildAssetFiles,
  lookup,
  storageUrl,
  type AssetEntry,
  type AssetFiles,
} from "./manifest.js";

const CLOUD_URL = "https://happy-cat-123.convex.cloud";
const config = siteConfig({});

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A storage URL as Convex makes them, with a key of the given length. */
function url(key: string) {
  return `${CLOUD_URL}/api/storage/${key}?component=m026ambq8g7g5yxf42tb4d4tfx8hg303`;
}

/** `count` entries with distinct bytes; every third shares the bytes of the one before. */
async function entries(count: number, paths = (i: number) => `/assets/chunk-${i}.js`) {
  const list: AssetEntry[] = [];
  for (let i = 0; i < count; i++) {
    const body = `body ${i - (i % 3 === 2 ? 1 : 0)}`;
    const sha256 = await sha256Hex(body);
    list.push({
      path: paths(i),
      sha256,
      contentType: i % 5 === 4 ? undefined : i % 2 === 0 ? "text/javascript" : "text/html",
      url: url(sha256.slice(0, 36)),
    });
  }
  return list;
}

/**
 * The reference reader: it decodes the whole manifest and reads every entry into a map by path
 * hash, the plain way, which `lookup` must agree with for every path and every miss.
 */
async function reference(files: AssetFiles) {
  const bytes = Uint8Array.from(atob(files.manifest), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const hex = (from: number, to: number) =>
    Array.from(bytes.subarray(from, to), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const byPathHash = new Map<string, unknown>();
  for (let offset = 20; offset < bytes.length; offset += 40) {
    const contentType = view.getUint16(offset + 36);
    byPathHash.set(hex(offset, offset + 16), {
      contentHash: hex(offset + 16, offset + 32),
      file: view.getUint32(offset + 32),
      contentType: contentType === 0xffff ? undefined : files.contentTypes[contentType],
    });
  }
  return async (path: string) => byPathHash.get((await sha256Hex(path)).slice(0, 32)) ?? null;
}

describe("buildAssetFiles and lookup", () => {
  test("every path finds its entry, and the reference reader agrees, at every size up to 64", async () => {
    // Entries start 20 + 40i bytes in, so successive sizes put entries at every base64 alignment.
    for (let count = 0; count <= 64; count++) {
      const list = await entries(count);
      const files = await buildAssetFiles(CLOUD_URL, config, list);
      const read = await reference(files);
      for (const entry of list) {
        const hit = await lookup(files, entry.path);
        expect(hit).toEqual(await read(entry.path));
        expect(hit).toEqual({
          contentHash: entry.sha256.slice(0, 32),
          file: hit?.file,
          contentType: entry.contentType,
        });
        expect(storageUrl(files.storage, hit?.file ?? -1)).toBe(entry.url);
      }
      expect(await lookup(files, "/assets/missing.js")).toBeNull();
    }
  });

  test("paths with Unicode, spaces, and percent signs are found as the handler decodes them", async () => {
    const paths = [
      "/café/menu.html",
      "/a b/c.txt",
      "/100%.html",
      "/日本語/索引.html",
      "/emoji/🙂.svg",
    ];
    const list = await entries(paths.length, (i) => paths[i]);
    const files = await buildAssetFiles(CLOUD_URL, config, list);
    for (const path of paths) expect(await lookup(files, path)).not.toBeNull();
    expect(await lookup(files, "/caf%C3%A9/menu.html")).toBeNull();
  });

  test("a large site: 5,000 entries all found, and misses miss", async () => {
    const list = await entries(5000);
    const files = await buildAssetFiles(CLOUD_URL, config, list);
    const read = await reference(files);
    for (const entry of list.filter((_, i) => i % 97 === 0)) {
      expect(await lookup(files, entry.path)).toEqual(await read(entry.path));
    }
    for (let i = 5000; i < 5100; i++)
      expect(await lookup(files, `/assets/chunk-${i}.js`)).toBeNull();
  });

  test("paths with the same bytes share one stored file and keep their own content types", async () => {
    const sha256 = await sha256Hex("same");
    const files = await buildAssetFiles(CLOUD_URL, config, [
      { path: "/a.txt", sha256, contentType: "text/plain", url: url("k1") },
      { path: "/a.js", sha256, contentType: "text/javascript", url: url("k1") },
    ]);
    const txt = await lookup(files, "/a.txt");
    const js = await lookup(files, "/a.js");
    expect(txt?.file).toBe(js?.file);
    expect(txt?.contentHash).toBe(js?.contentHash);
    expect([txt?.contentType, js?.contentType]).toEqual(["text/plain", "text/javascript"]);
    // One stored file: its whole URL is the shared part.
    expect(files.storage).toEqual({ prefix: url("k1"), suffix: "", width: 0, keys: "" });
    expect(storageUrl(files.storage, txt?.file ?? -1)).toBe(url("k1"));
  });

  test("storage keys of different lengths are padded, and every URL is rebuilt exactly", async () => {
    const keys = ["a", "bcd", "efghij", "klmnopqrstuvwxyz0123456789abcdef0123"];
    const list = await entries(keys.length);
    keys.forEach((key, i) => (list[i].url = url(key)));
    const files = await buildAssetFiles(CLOUD_URL, config, list);
    expect(files.storage.prefix).toBe(`${CLOUD_URL}/api/storage/`);
    expect(files.storage.suffix).toBe("?component=m026ambq8g7g5yxf42tb4d4tfx8hg303");
    for (const entry of list) {
      const hit = await lookup(files, entry.path);
      expect(storageUrl(files.storage, hit?.file ?? -1)).toBe(entry.url);
    }
  });

  test("a site with one file or no file", async () => {
    const [one] = await entries(1);
    const single = await buildAssetFiles(CLOUD_URL, config, [one]);
    expect(storageUrl(single.storage, (await lookup(single, one.path))?.file ?? -1)).toBe(one.url);
    const empty = await buildAssetFiles(CLOUD_URL, config, []);
    expect(await lookup(empty, "/index.html")).toBeNull();
  });
});
