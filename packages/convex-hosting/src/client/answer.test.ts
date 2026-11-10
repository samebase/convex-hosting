import { describe, expect, test } from "vite-plus/test";
import { siteConfig } from "../cli/site-config.js";
import type { Config } from "../component/lib.js";
import { encodingTestCases } from "../workers-sdk/fixtures/workers-shared-asset-config/test-cases/encoding-test-cases.js";
import { htmlHandlingTestCases } from "../workers-sdk/fixtures/workers-shared-asset-config/test-cases/html-handling-test-cases.js";
import { answer } from "./answer.js";
import { buildAssetFiles } from "../cli/manifest.js";
import type { AssetFiles } from "./manifest.js";

type Files = Record<string, { body: string; contentType?: string }>;

const CLOUD_URL = "https://example.convex.cloud";
const ORIGIN = "https://example.convex.site";

async function sha256Hex(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The ETag of `body` under `contentType`: the content hash, which covers both. */
async function eTagOf(body: string, contentType?: string) {
  return (await sha256Hex(`${await sha256Hex(body)}\n${contentType ?? ""}`)).slice(0, 32);
}

/** The stored file's URL of `body`: it names the bytes, so a test can tell which file answered. */
async function bodyUrl(body: string) {
  return `${CLOUD_URL}/api/storage/${await sha256Hex(body)}`;
}

/** The site's files for `files` and `config`, as the upload builds them. */
async function siteFiles(files: Files, config: Config = {}) {
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, { body, contentType }]) => ({
      path,
      sha256: await sha256Hex(body),
      contentType,
      url: await bodyUrl(body),
    })),
  );
  return buildAssetFiles(CLOUD_URL, siteConfig(config), entries);
}

/** Cloudflare's answer to one request, with the storage URL of its body, or `null` for a miss. */
async function route(
  files: AssetFiles,
  path: string,
  headers: Record<string, string> = {},
  hasUserWorker = true,
  method = "GET",
) {
  const asset = await answer(files, new Request(ORIGIN + path, { method, headers }), hasUserWorker);
  if (asset === null) return null;
  return {
    status: asset.status,
    headers: Object.fromEntries(asset.headers),
    bodyUrl: asset.url,
  };
}

const site: Files = {
  "/index.html": { body: "<h1>Home</h1>", contentType: "text/html; charset=utf-8" },
  "/404.html": { body: "<h1>Missing</h1>", contentType: "text/html; charset=utf-8" },
  "/assets/app-a1.js": { body: "console.log(1)", contentType: "text/javascript; charset=utf-8" },
};

describe("answer", () => {
  test("a hit has Cloudflare's headers and an ETag; If-None-Match answers 304", async () => {
    const files = await siteFiles(site);
    const hit = await route(files, "/assets/app-a1.js");
    expect(hit?.status).toBe(200);
    expect(hit?.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(hit?.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(hit?.headers["cf-cache-status"]).toBeUndefined();
    const eTag = hit?.headers.etag;
    expect(eTag).toBe(`"${await eTagOf("console.log(1)", "text/javascript; charset=utf-8")}"`);
    expect(hit?.bodyUrl).toBe(await bodyUrl("console.log(1)"));

    const revalidated = await route(files, "/assets/app-a1.js", { "if-none-match": eTag ?? "" });
    expect(revalidated?.status).toBe(304);
    expect(revalidated?.bodyUrl).toBeNull();
  });

  test("the same bytes under two content types have two ETags", async () => {
    const files = await siteFiles({
      "/a.txt": { body: "same", contentType: "text/plain" },
      "/a.js": { body: "same", contentType: "text/javascript" },
    });
    const txt = await route(files, "/a.txt");
    const js = await route(files, "/a.js");
    expect(txt?.headers.etag).not.toBe(js?.headers.etag);
    expect(js?.headers["content-type"]).toBe("text/javascript");
    expect(txt?.bodyUrl).toBe(js?.bodyUrl);
  });

  test("with code, single-page-application answers navigations only", async () => {
    const files = await siteFiles(site, { not_found_handling: "single-page-application" });
    const navigation = await route(files, "/settings/profile", { "sec-fetch-mode": "navigate" });
    const index = await route(files, "/");
    expect(navigation?.status).toBe(200);
    expect(navigation?.headers.etag).toBe(index?.headers.etag);
    expect(await route(files, "/settings/profile")).toBeNull();
  });

  test("without code, single-page-application answers every request, as a files-only Worker", async () => {
    const files = await siteFiles(site, { not_found_handling: "single-page-application" });
    const index = await route(files, "/");
    // No `Sec-Fetch-Mode`, as from curl, a monitor, or a link-preview bot.
    const filesOnly = await route(files, "/about", {}, false);
    expect(filesOnly?.status).toBe(200);
    expect(filesOnly?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(filesOnly?.headers.etag).toBe(index?.headers.etag);
    // With code, the same request is a miss, which the app answers.
    expect(await route(files, "/about", {}, true)).toBeNull();
  });

  test("without code and with html_handling none, / answers index.html through the fallback", async () => {
    const files = await siteFiles(site, {
      html_handling: "none",
      not_found_handling: "single-page-application",
    });
    const root = await route(files, "/", {}, false);
    const index = await route(files, "/index.html", {}, false);
    expect(root?.status).toBe(200);
    expect(root?.headers.etag).toBe(index?.headers.etag);
  });

  test("another method than GET or HEAD on a file answers 405; on a miss, the code or 404", async () => {
    const files = await siteFiles(site);
    for (const hasUserWorker of [true, false]) {
      const post = await route(files, "/index.html", {}, hasUserWorker, "POST");
      expect(post?.status).toBe(405);
      expect(post?.bodyUrl).toBeNull();
    }
    expect(await route(files, "/missing", {}, true, "POST")).toBeNull();
    expect((await route(files, "/missing", {}, false, "POST"))?.status).toBe(404);
  });

  test("HEAD answers the file's headers without its body", async () => {
    const files = await siteFiles(site);
    const head = await route(files, "/", {}, true, "HEAD");
    expect(head?.status).toBe(200);
    expect(head?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(head?.bodyUrl).toBeNull();
  });

  test("without code, a miss with not_found_handling none answers 404 with no-store", async () => {
    const files = await siteFiles(site);
    expect(await route(files, "/missing", {}, false)).toEqual({
      status: 404,
      headers: { "cache-control": "no-store" },
      bodyUrl: null,
    });
  });

  test("the custom 404 page answers with its body and no-store", async () => {
    const files = await siteFiles(site, { not_found_handling: "404-page" });
    const page = await route(files, "/missing", { "sec-fetch-mode": "navigate" });
    expect(page?.status).toBe(404);
    expect(page?.bodyUrl).toBe(await bodyUrl("<h1>Missing</h1>"));
    expect(page?.headers["cache-control"]).toBe("no-store");
    const filesOnly = await route(files, "/missing", {}, false);
    expect(filesOnly?.status).toBe(404);
    expect(filesOnly?.headers.etag).toBe(page?.headers.etag);
  });

  test("a _headers rule applies", async () => {
    const files = await siteFiles(site, {
      headers: {
        version: 2,
        rules: { "/assets/*": { set: { "Cache-Control": "public, max-age=31536000, immutable" } } },
      },
    });
    const hit = await route(files, "/assets/app-a1.js");
    expect(hit?.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("a _redirects rule applies", async () => {
    const files = await siteFiles(site, {
      redirects: {
        version: 1,
        staticRules: { "/old": { status: 301, to: "/", lineNumber: 1 } },
        rules: {},
      },
    });
    const redirect = await route(files, "/old?x=1");
    expect(redirect?.status).toBe(301);
    expect(redirect?.headers.location).toBe("/?x=1");
    expect(redirect?.bodyUrl).toBeNull();
  });
});

// Cloudflare's own cases for `html_handling` and path encoding, from
// fixtures/workers-shared-asset-config in cloudflare/workers-sdk. Upstream runs them against its
// asset Worker with `exists` mocked; here the files are a site's manifest.
describe("Cloudflare's conformance cases", () => {
  /** Requests `path` and follows redirects, as the upstream test's `fetch` does. */
  async function follow(files: AssetFiles, path: string) {
    let url = ORIGIN + path;
    for (let hop = 0; hop < 8; hop++) {
      const asset = await answer(files, new Request(url), false);
      if (asset === null) throw new Error(`No asset for ${url}`);
      const location = asset.headers.get("location");
      if (location !== null && asset.status >= 300 && asset.status < 400) {
        url = new URL(location, url).href;
        continue;
      }
      return { status: asset.status, url, eTag: asset.headers.get("etag"), redirected: hop > 0 };
    }
    throw new Error(`Too many redirects from ${path}`);
  }

  const suites = [
    { title: "html_handling", suite: htmlHandlingTestCases },
    { title: "encoding", suite: encodingTestCases },
  ];

  describe.each(suites)("$title", ({ suite }) => {
    describe.each(suite)("$html_handling", ({ html_handling, cases }) => {
      test.each(cases)("$title", async ({ files, requestPath, matchedFile, finalPath }) => {
        // Each file's body is its own path, so the ETag names it.
        const site = await siteFiles(
          Object.fromEntries(files.map((path) => [path, { body: path }])),
          { html_handling, not_found_handling: "none" },
        );
        const response = await follow(site, requestPath);
        if (matchedFile && finalPath) {
          expect(response.status).toBe(200);
          expect(response.url).toBe(ORIGIN + finalPath);
          expect(response.redirected).toBe(requestPath !== finalPath);
          expect(response.eTag).toBe(`"${await eTagOf(matchedFile)}"`);
        } else {
          expect(response.status).toBe(404);
        }
      });
    });
  });
});
