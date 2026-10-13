/// <reference types="vite/client" />

import { describe, expect, test } from "vite-plus/test";
import { api } from "./_generated/api.js";
import { etagMatches } from "./serving.js";
import { deployTestVersion, initConvexTest, testVersionId, type TestFile } from "./setup.test.js";

const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const IMMUTABLE = "public, max-age=31536000, immutable";

const files: Record<string, TestFile> = {
  "/index.html": { body: "<h1>Home</h1>", contentType: HTML },
  "/about/index.html": { body: "<h1>About</h1>", contentType: HTML },
  "/contact.html": { body: "<h1>Contact</h1>", contentType: HTML },
  "/assets/app-1.js": { body: "console.log(1)", contentType: JS, immutable: true },
};

async function deployed(config = {}) {
  const t = initConvexTest();
  await deployTestVersion(t, testVersionId("a"), files, config);
  return t;
}

const navigate = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const script = { "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script" };

describe("the component's route", () => {
  test("answers 404 with no-store before the first activation", async () => {
    const t = initConvexTest();
    const response = await t.fetch("/", { headers: navigate });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("serves a file with an ETag, and 304 for a matching If-None-Match", async () => {
    const t = await deployed();
    const response = await t.fetch("/", { headers: navigate });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(HTML);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(await response.text()).toBe("<h1>Home</h1>");
    const etag = response.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{64}-[0-9a-f]{8}"$/);

    const revalidated = await t.fetch("/", {
      headers: { ...navigate, "If-None-Match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  test("answers 304 for a list that contains the ETag and for *", async () => {
    const t = await deployed();
    const response = await t.fetch("/assets/app-1.js", { headers: script });
    const etag = response.headers.get("ETag") ?? "";
    for (const ifNoneMatch of [`"other", W/${etag}`, "*"]) {
      const revalidated = await t.fetch("/assets/app-1.js", {
        headers: { ...script, "If-None-Match": ifNoneMatch },
      });
      expect(revalidated.status).toBe(304);
      expect([...revalidated.headers.keys()]).toEqual(["cache-control", "etag"]);
      expect(revalidated.headers.get("Cache-Control")).toBe(IMMUTABLE);
      expect(revalidated.headers.get("ETag")).toBe(etag);
      expect(await revalidated.text()).toBe("");
    }
    const changed = await t.fetch("/assets/app-1.js", {
      headers: { ...script, "If-None-Match": '"other"' },
    });
    expect(changed.status).toBe(200);
  });

  test("etagMatches supports weak tags, lists, and wildcard validators", () => {
    expect(etagMatches('W/"asset-1"', '"asset-1"')).toBe(true);
    expect(etagMatches('"other", W/"asset-1"', '"asset-1"')).toBe(true);
    expect(etagMatches("*", '"asset-1"')).toBe(true);
    expect(etagMatches('"other"', '"asset-1"')).toBe(false);
    expect(etagMatches(null, '"asset-1"')).toBe(false);
  });

  test("answers HEAD without a body", async () => {
    const t = await deployed();
    const routed = await t.query(api.lib.route, {
      method: "HEAD",
      url: "https://app.convex.site/assets/app-1.js",
      headers: [],
      exact: false,
    });
    expect(routed).toMatchObject({ handled: true, status: 200, body: null });

    const response = await t.fetch("/assets/app-1.js", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).not.toBeNull();
    expect(await response.text()).toBe("");
  });

  test("sends the immutable header for an immutable entry and no-store for a 404", async () => {
    const t = await deployed();
    const response = await t.fetch("/assets/app-1.js", { headers: script });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(await response.text()).toBe("console.log(1)");

    const revalidated = await t.fetch("/assets/app-1.js", {
      headers: { ...script, "If-None-Match": response.headers.get("ETag") ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("Cache-Control")).toBe(IMMUTABLE);

    const missing = await t.fetch("/assets/app-2.js", { headers: script });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });

  test("redirects with auto-trailing-slash", async () => {
    const t = await deployed();
    const redirects: Array<[string, string]> = [
      ["/about", "/about/"],
      ["/about/index.html", "/about/"],
      ["/contact.html", "/contact"],
    ];
    for (const [from, to] of redirects) {
      const response = await t.fetch(from, { headers: navigate });
      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toBe(to);
    }
    expect(await (await t.fetch("/about/", { headers: navigate })).text()).toBe("<h1>About</h1>");
    expect(await (await t.fetch("/contact", { headers: navigate })).text()).toBe(
      "<h1>Contact</h1>",
    );
  });

  test("serves index.html to a navigation in SPA mode and 404 to a missing script", async () => {
    const t = await deployed({ not_found_handling: "single-page-application" });
    const page = await t.fetch("/dashboard/settings", { headers: navigate });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>Home</h1>");

    const missing = await t.fetch("/assets/missing.js", { headers: script });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });

  test("an error drops the cache headers of a _headers rule", async () => {
    const t = await deployed({
      headers: {
        version: 2,
        rules: {
          "/*": {
            set: { "Cache-Control": "public, max-age=3600", "CDN-Cache-Control": "max-age=60" },
          },
        },
      },
    });
    const missing = await t.fetch("/missing.js", { headers: script });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(missing.headers.get("CDN-Cache-Control")).toBeNull();

    const found = await t.fetch("/contact", { headers: navigate });
    expect(found.headers.get("CDN-Cache-Control")).toBe("max-age=60");
  });

  test("serves the 404 page of 404-page mode with its body", async () => {
    const t = initConvexTest();
    await deployTestVersion(
      t,
      testVersionId("a"),
      { ...files, "/404.html": { body: "<h1>Lost</h1>", contentType: HTML } },
      { not_found_handling: "404-page" },
    );
    const response = await t.fetch("/nowhere", { headers: navigate });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("<h1>Lost</h1>");
  });
});
