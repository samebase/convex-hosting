// A fake `npx convex` and `fetch` for the upload and deploy tests: the component functions of
// contract version 2, storage upload URLs, and the deployment's site. Tests replace single
// functions to make them fail.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Cli } from "./commands.js";
import { sha256Hex } from "./manifest.js";

type Args = { [key: string]: unknown };
type Entry = { path: string; sha256: string; size: number; storageId: string | null };

const CLOUD_URL = "https://happy-animal-123.convex.cloud";
export const SITE_URL = "https://happy-animal-123.convex.site";

export function writeDist(files: { [path: string]: string }): string {
  const dist = mkdtempSync(join(tmpdir(), "convex-hosting-dist-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

export function fakeCli() {
  /** Every call in order: a function name, `fetch <METHOD> <url>`, `deploy`, or `function-spec`. */
  const calls: string[] = [];
  const runs: { fn: string; args: Args; argv: string[] }[] = [];
  const pushes: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const versions = new Map<string, { state: "uploading" | "ready"; entries: Entry[] }>();
  let live: string | null = null;
  let uploadUrls = 0;

  const pendingOf = (versionId: string) => {
    const version = versions.get(versionId);
    if (version === undefined) throw new Error(`No version ${versionId}`);
    return version.entries.filter((entry) => entry.storageId === null);
  };

  const functions: { [fn: string]: (args: Args) => unknown } = {
    "lib:getLiveVersion": () => (live === null ? null : { versionId: live, liveAt: 1 }),
    "lib:generateUploadUrl": () => `https://upload.test/${++uploadUrls}`,
    "lib:startVersion": ({ versionId, manifestStorageId }) => {
      const blob = blobs.get(String(manifestStorageId));
      if (blob === undefined) throw new Error("No manifest");
      const manifest: { entries: Entry[] } = JSON.parse(new TextDecoder().decode(blob.bytes));
      const id = String(versionId);
      if (!versions.has(id)) {
        const entries = manifest.entries.map((entry) => ({ ...entry, storageId: null }));
        versions.set(id, { state: "uploading", entries });
      }
      const version = versions.get(id);
      return {
        state: version?.state,
        pending: pendingOf(id).map(({ path, sha256 }) => ({ path, sha256 })),
      };
    },
    "lib:recordFile": ({ versionId, path, storageId }) => {
      const entry = versions.get(String(versionId))?.entries.find((each) => each.path === path);
      const blob = blobs.get(String(storageId));
      if (entry === undefined || blob === undefined) throw new Error("No entry or blob");
      if (sha256Hex(blob.bytes) !== entry.sha256) return { ok: false, reason: "sha256 mismatch" };
      entry.storageId = String(storageId);
      return { ok: true };
    },
    "lib:finishVersion": ({ versionId }) => {
      const id = String(versionId);
      const pending = pendingOf(id);
      const version = versions.get(id);
      if (version !== undefined && pending.length === 0) version.state = "ready";
      return {
        state: version?.state,
        pending: pending.map(({ path, sha256 }) => ({ path, sha256 })),
      };
    },
    "lib:activate": ({ versionId }) => {
      if (versions.get(String(versionId))?.state !== "ready") throw new Error("Not ready");
      const previousVersionId = live;
      live = String(versionId);
      return { previousVersionId };
    },
  };

  /** The deployment's answer to a GET of its site. */
  let site = (_url: string): Response => new Response("Not Found", { status: 404 });
  /** The exit status of `npx convex deploy`. */
  let push = (_argv: string[], _env: NodeJS.ProcessEnv): number | null => 0;

  const cli: Cli = {
    convex: async (argv) => {
      if (argv[0] === "function-spec") {
        calls.push("function-spec");
        return JSON.stringify({ url: CLOUD_URL, functions: [] }, null, 2);
      }
      const fn = argv[3];
      const args: Args = JSON.parse(argv[4]);
      calls.push(fn);
      runs.push({ fn, args, argv });
      const result = functions[fn](args);
      return result === null ? "" : JSON.stringify(result, null, 2);
    },
    convexInherit: (argv, env) => {
      calls.push("deploy");
      pushes.push({ argv, env });
      return push(argv, env);
    },
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : "href" in input ? input.href : input.url;
      calls.push(`fetch ${init?.method ?? "GET"} ${url}`);
      if (!url.startsWith("https://upload.test/")) return site(url);
      const body = init?.body;
      // Buffers come from Node's realm, not the test environment's, so `instanceof` fails.
      if (typeof body !== "string" && !ArrayBuffer.isView(body)) throw new Error("Unexpected body");
      const bytes =
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      const storageId = `storage${blobs.size + 1}`;
      blobs.set(storageId, {
        bytes,
        contentType: new Headers(init?.headers).get("Content-Type") ?? "",
      });
      return Response.json({ storageId });
    },
  };

  return {
    cli,
    calls,
    runs,
    pushes,
    blobs,
    versions,
    functions,
    setLive: (versionId: string | null) => {
      live = versionId;
    },
    setSite: (handler: typeof site) => {
      site = handler;
    },
    setPush: (handler: typeof push) => {
      push = handler;
    },
  };
}
