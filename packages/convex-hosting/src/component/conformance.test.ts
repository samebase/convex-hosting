/// <reference types="vite-plus/client" />
// Cloudflare's own cases for `html_handling` and path encoding, from
// fixtures/workers-shared-asset-config in cloudflare/workers-sdk, run through `route`. Upstream
// runs them against its asset Worker with `exists` mocked; here the files are a version's entries.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";
import type { Config } from "./lib.js";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";
import { encodingTestCases } from "../workers-sdk/fixtures/workers-shared-asset-config/test-cases/encoding-test-cases.js";
import { htmlHandlingTestCases } from "../workers-sdk/fixtures/workers-shared-asset-config/test-cases/html-handling-test-cases.js";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const ORIGIN = "https://example.convex.site";

async function sha256Hex(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Uploads `files` as version `versionId`. Each file's body is its own path, so the ETag names it. */
async function uploadVersion(
  t: ReturnType<typeof convexTest>,
  versionId: string,
  files: string[],
  config: Config,
) {
  const configId = await t.run((ctx) => ctx.storage.store(new Blob([JSON.stringify(config)])));
  await t.action(internal.lib.createVersion, { versionId, configId });
  const entries = [];
  for (const path of files) {
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([path])));
    entries.push({ path, sha256: await sha256Hex(path), storageId });
  }
  await t.mutation(internal.lib.recordFiles, { versionId, entries });
  await t.mutation(internal.lib.finishVersion, { versionId });
}

/** Requests `path` and follows redirects, as the upstream test's `fetch` does. */
async function follow(t: ReturnType<typeof convexTest>, versionId: string, path: string) {
  let url = ORIGIN + path;
  for (let hop = 0; hop < 8; hop++) {
    const { asset } = await t.query(api.lib.route, {
      versionId,
      method: "GET",
      url,
      headers: {},
      hasUserWorker: false,
    });
    if (asset === null) throw new Error(`No asset for ${url}`);
    const header = (name: string) => asset.headers.find((h) => h.name === name)?.value;
    const location = header("location");
    if (location !== undefined && asset.status >= 300 && asset.status < 400) {
      url = new URL(location, url).href;
      continue;
    }
    return { status: asset.status, url, eTag: header("etag"), redirected: hop > 0 };
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
      const t = convexTest(schema, modules);
      await uploadVersion(t, "v1", files, { html_handling, not_found_handling: "none" });
      const response = await follow(t, "v1", requestPath);
      if (matchedFile && finalPath) {
        expect(response.status).toBe(200);
        expect(response.url).toBe(ORIGIN + finalPath);
        expect(response.redirected).toBe(requestPath !== finalPath);
        expect(response.eTag).toMatch(new RegExp(`^"${await sha256Hex(matchedFile)}`));
      } else {
        expect(response.status).toBe(404);
      }
    });
  });
});
