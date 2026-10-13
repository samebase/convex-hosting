// @vitest-environment node
// The CLI runs in Node; the edge-runtime environment of the other tests has no `process.execPath`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { deploymentFlags, type Cli } from "./convex.js";
import { main, VERSION_FILE } from "./main.js";

const MISSING = `✖ Component path "hosting" was not found.\n\nThis deployment has no mounted components.`;

/** An app directory with `convex/` and the given files. */
function app(files: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), "convex-hosting-cli-"));
  mkdirSync(join(cwd, "convex"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
  }
  return cwd;
}

/**
 * A fake `Cli`: `npx convex run` answers like a deployment with the component, and
 * `npx convex deploy` calls `push`. No processes, no network.
 */
function fake(
  cwd: string,
  options: {
    env?: Record<string, string>;
    installed?: () => boolean;
    push?: (cli: Cli, args: string[]) => Promise<number>;
  } = {},
) {
  const runs: string[][] = [];
  const pushes: string[][] = [];
  const stored = new Map<string, string>();
  const logs: string[] = [];
  let entries: { path: string; sha256: string }[] = [];
  const recorded = new Set<string>();
  const ok = (value: unknown) => ({
    exitCode: 0,
    stdout: value === null ? "" : JSON.stringify(value, null, 2),
    stderr: "",
  });
  const cli: Cli = {
    cwd,
    env: options.env ?? {},
    convex: async (args) => {
      runs.push(args);
      if (args.includes("--inline-query")) {
        return (options.installed?.() ?? true)
          ? ok(null)
          : { exitCode: 1, stdout: "", stderr: MISSING };
      }
      const fnArgs = JSON.parse(args[4]);
      switch (args[3]) {
        case "lib:generateUploadUrls":
          return ok(Array.from({ length: fnArgs.count }, (_, i) => `https://upload/${i}`));
        case "lib:startVersion":
          entries = JSON.parse(stored.get(fnArgs.manifestId) ?? "").entries;
          return ok(null);
        case "lib:missingEntries":
          return ok(entries.filter(({ path }) => !recorded.has(path)));
        case "lib:recordFiles":
          for (const { path } of fnArgs.files) recorded.add(path);
          return ok(null);
        case "lib:finishVersion":
          return ok(true);
        default:
          return ok(null);
      }
    },
    convexInherited: async (args) => {
      pushes.push(args);
      return (await options.push?.(cli, args)) ?? 0;
    },
    fetch: async (_url, init) => {
      const storageId = `storage-${stored.size}`;
      stored.set(storageId, await new Response(init?.body).text());
      return Response.json({ storageId });
    },
    log: (message) => logs.push(message),
  };
  const calls = () => runs.map((args) => (args.includes("--inline-query") ? "probe" : args[3]));
  const callArgs = (name: string) =>
    runs.filter((args) => args[3] === name).map((args) => JSON.parse(args[4]));
  return { cli, runs, pushes, stored, logs, calls, callArgs };
}

/** Waits for `promise` while the fake timers advance. */
async function withTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(() => (settled = true));
  while (!settled) await vi.advanceTimersByTimeAsync(1_000);
  return await promise;
}

/** Runs the upload that `deploy` put in `--cmd`, the way the shell would. */
function innerUpload(cli: Cli, args: string[]) {
  const command = args[args.indexOf("--cmd") + 1];
  const quoted = [...command.slice(command.lastIndexOf("&&")).matchAll(/'([^']*)'/g)];
  return main(
    quoted.slice(2).map(([, arg]) => arg),
    cli,
  );
}

const versionFile = (cwd: string) => readFileSync(join(cwd, VERSION_FILE), "utf8");
const writtenVersionId = (cwd: string) => /"([^"]+)"/.exec(versionFile(cwd))?.[1];

const site = {
  "dist/index.html": "<h1>Home</h1>",
  "dist/copy.html": "<h1>Home</h1>",
  "dist/assets/app.js": "console.log(1)",
  "dist/assets/app.js.map": "{}",
  "dist/private/notes.txt": "secret",
  "dist/.assetsignore": "private\n*.map\n",
  "dist/_headers": "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
  "dist/_redirects": "/old / 301\n",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("upload", () => {
  test("uploads the files that .assetsignore keeps, with the config from _headers and _redirects", async () => {
    const cwd = app(site);
    const { cli, calls, callArgs, stored, runs } = fake(cwd);
    const exitCode = await main(
      ["upload", "--dist", "dist", "--not-found-handling", "single-page-application"],
      cli,
    );

    expect(exitCode).toBe(0);
    expect(calls()).toEqual([
      "probe",
      "lib:generateUploadUrls",
      "lib:startVersion",
      "lib:missingEntries",
      "lib:generateUploadUrls",
      "lib:recordFiles",
      "lib:missingEntries",
      "lib:finishVersion",
      "lib:finishDeploy",
    ]);
    // A user-run upload goes where `npx convex run` goes by default.
    expect(runs.every((args) => !args.includes("--prod"))).toBe(true);

    const manifest = JSON.parse(stored.get("storage-0") ?? "");
    expect(manifest.config).toEqual({
      html_handling: "auto-trailing-slash",
      not_found_handling: "single-page-application",
      redirects: {
        version: 1,
        staticRules: { "/old": { status: 301, to: "/", lineNumber: 1 } },
        rules: {},
      },
      headers: {
        version: 2,
        rules: { "/assets/*": { set: { "cache-control": "public, max-age=31536000, immutable" } } },
      },
    });
    expect(manifest.entries.map((entry: { path: string }) => entry.path).sort()).toEqual([
      "/assets/app.js",
      "/copy.html",
      "/index.html",
    ]);
    expect(manifest.entries).toContainEqual({
      path: "/index.html",
      sha256: createHash("sha256").update("<h1>Home</h1>").digest("hex"),
      contentType: "text/html; charset=utf-8",
    });
    // Two entries with the same bytes share one stored file.
    expect(callArgs("lib:generateUploadUrls")[1]).toEqual({ count: 2 });

    const versionId = writtenVersionId(cwd);
    expect(callArgs("lib:finishDeploy")).toEqual([{ versionId, pushed: true }]);
  });

  test("on a new clone, writes the version file, waits for the push of the component, then uploads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const cwd = app(site);
    // The version id in the version file at each probe.
    const probes: (string | undefined)[] = [];
    const { cli, calls, callArgs, logs } = fake(cwd, {
      installed: () => {
        probes.push(existsSync(join(cwd, VERSION_FILE)) ? writtenVersionId(cwd) : undefined);
        return probes.length > 3;
      },
    });
    expect(await withTimers(main(["upload", "--dist", "dist"], cli))).toBe(0);

    expect(logs).toContainEqual(expect.stringContaining("npx convex dev now pushes the component"));
    expect(versionFile(cwd)).toMatch(/^export const versionId = "[^"]+";\n$/);
    expect(readFileSync(join(cwd, ".convex-hosting", ".gitignore"), "utf8")).toBe("*\n");
    const versionId = writtenVersionId(cwd);
    expect(probes).toEqual([undefined, versionId, versionId, versionId]);
    expect(calls()[4]).toBe("lib:generateUploadUrls");
    expect(callArgs("lib:finishDeploy")).toEqual([{ versionId, pushed: true }]);
  });

  test("on a new clone, stops when the component is not pushed in 2 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const cwd = app(site);
    const { cli, calls, logs } = fake(cwd, { installed: () => false });
    expect(await withTimers(main(["upload", "--dist", "dist"], cli))).toBe(1);
    // The first probe, then one every 3 seconds for 2 minutes.
    expect(calls()).toEqual(Array.from({ length: 41 }, () => "probe"));
    expect(logs[logs.length - 1]).toBe(
      'The component "hosting" is not installed: npx convex dev did not push it in 2 minutes.',
    );
  });

  test("calls heartbeat every 30 seconds while a long page of files uploads", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cwd = app(site);
    const { cli, calls, callArgs } = fake(cwd);
    const storeFile = cli.fetch;
    let slow = true;
    cli.fetch = async (url, init) => {
      // The first file of the page takes 65 seconds; the manifest is stored before `startVersion`.
      if (calls().includes("lib:startVersion") && slow) {
        slow = false;
        await vi.advanceTimersByTimeAsync(65_000);
      }
      return await storeFile(url, init);
    };
    expect(await main(["upload", "--dist", "dist"], cli)).toBe(0);
    const versionId = writtenVersionId(cwd);
    expect(callArgs("lib:heartbeat")).toEqual([{ versionId }, { versionId }]);
    expect(calls().indexOf("lib:heartbeat")).toBeGreaterThan(calls().indexOf("lib:startVersion"));
  });

  test("any other failure of the probe is an error", async () => {
    const cwd = app(site);
    const { cli, logs } = fake(cwd);
    cli.convex = async () => ({ exitCode: 1, stdout: "", stderr: "✖ Not logged in." });
    expect(await main(["upload", "--dist", "dist"], cli)).toBe(1);
    expect(logs).toContain("✖ Not logged in.");
    expect(existsSync(join(cwd, VERSION_FILE))).toBe(false);
  });

  test("refuses --preview-name and a deploy key: those deployments get deploy", async () => {
    const refusal = "convex-hosting upload targets the development deployment";
    const preview = fake(app(site));
    expect(await main(["upload", "--dist", "dist", "--preview-name", "pr-7"], preview.cli)).toBe(1);
    expect(preview.logs[preview.logs.length - 1]).toContain(refusal);
    expect(preview.runs).toEqual([]);

    const keyed = fake(
      app({ ...site, ".env.local": "CONVEX_DEPLOY_KEY=prod:happy-cat-123|secret\n" }),
    );
    expect(await main(["upload", "--dist", "dist"], keyed.cli)).toBe(1);
    expect(keyed.logs[keyed.logs.length - 1]).toContain(refusal);
    expect(keyed.runs).toEqual([]);
  });

  test("refuses a config above 900 KiB and names the file", async () => {
    const long = "x".repeat(450);
    const redirects = Array.from({ length: 2000 }, (_, i) => `/${i}${long} /${i}${long}-to 301`);
    const cwd = app({ "dist/index.html": "", "dist/_redirects": redirects.join("\n") });
    const { cli, logs, runs } = fake(cwd);
    expect(await main(["upload", "--dist", "dist"], cli)).toBe(1);
    expect(logs[logs.length - 1]).toContain(join(cwd, "dist", "_redirects"));
    expect(runs).toEqual([]);
  });
});

describe("deploy", () => {
  test("runs the build and the upload inside npx convex deploy, then finishDeploy", async () => {
    const cwd = app(site);
    const { cli, pushes, runs, callArgs } = fake(cwd, { push: innerUpload });
    expect(await main(["deploy", "--build", "vite build", "--dist", "dist"], cli)).toBe(0);

    expect(pushes).toHaveLength(1);
    expect(pushes[0].slice(0, 2)).toEqual(["deploy", "--cmd"]);
    expect(pushes[0][2]).toMatch(
      /^vite build && '.+' '.+' 'upload' '--dist' '[^']+' '--version-id' '/,
    );
    expect(pushes[0][2]).toContain("'--dist' 'dist'");
    // Without a deploy key, `npx convex deploy` goes to production, so every run gets --prod.
    expect(runs.every((args) => args.includes("--prod"))).toBe(true);
    const versionId = writtenVersionId(cwd);
    expect(callArgs("lib:startVersion")[0].versionId).toBe(versionId);
    expect(callArgs("lib:finishDeploy")).toEqual([{ versionId, pushed: true }]);
  });

  test("on a first install, uploads after the push", async () => {
    const cwd = app(site);
    let pushed = false;
    const { cli, calls, callArgs } = fake(cwd, {
      installed: () => pushed,
      push: async (cli, args) => {
        const exitCode = await innerUpload(cli, args);
        expect(existsSync(join(cwd, ".convex-hosting", "first-install"))).toBe(true);
        expect(existsSync(join(cwd, VERSION_FILE))).toBe(true);
        pushed = true;
        return exitCode;
      },
    });
    expect(await main(["deploy", "--build", "vite build", "--dist", "dist"], cli)).toBe(0);

    expect(calls()[0]).toBe("probe");
    expect(calls().slice(1, 3)).toEqual(["probe", "lib:generateUploadUrls"]);
    expect(existsSync(join(cwd, ".convex-hosting", "first-install"))).toBe(false);
    expect(callArgs("lib:finishDeploy")).toEqual([
      { versionId: writtenVersionId(cwd), pushed: true },
    ]);
  });

  test("a failed push calls finishDeploy with pushed: false", async () => {
    const cwd = app(site);
    const { cli, callArgs, logs } = fake(cwd, {
      push: async (cli, args) => {
        await innerUpload(cli, args);
        return 1;
      },
    });
    expect(await main(["deploy", "--build", "vite build", "--dist", "dist"], cli)).toBe(1);
    expect(callArgs("lib:finishDeploy")).toEqual([
      { versionId: writtenVersionId(cwd), pushed: false },
    ]);
    expect(logs[logs.length - 1]).toBe("npx convex deploy failed with exit code 1.");
  });

  test("calls heartbeat every 30 seconds while the push runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cwd = app(site);
    const { cli, callArgs } = fake(cwd, {
      push: async () => {
        await vi.advanceTimersByTimeAsync(65_000);
        return 0;
      },
    });
    expect(await main(["deploy", "--build", "vite build", "--dist", "dist"], cli)).toBe(0);
    const heartbeats = callArgs("lib:heartbeat");
    expect(heartbeats).toHaveLength(2);
    expect(callArgs("lib:finishDeploy")).toEqual([
      { versionId: heartbeats[0].versionId, pushed: true },
    ]);
  });

  test("passes --preview-name to npx convex deploy and to every run", async () => {
    const cwd = app(site);
    const { cli, pushes, runs } = fake(cwd, { push: innerUpload });
    expect(
      await main(["deploy", "--build", "b", "--dist", "dist", "--preview-name", "pr-7"], cli),
    ).toBe(0);
    expect(pushes[0].slice(-2)).toEqual(["--preview-name", "pr-7"]);
    expect(runs.every((args) => args.slice(-2).join(" ") === "--preview-name pr-7")).toBe(true);
  });

  test("refuses a deployment's deploy key with --preview-name before anything runs", async () => {
    const cwd = app({ ...site, ".env.local": "CONVEX_DEPLOY_KEY=prod:happy-cat-123|secret\n" });
    const { cli, pushes, runs, logs } = fake(cwd);
    expect(
      await main(["deploy", "--build", "b", "--dist", "dist", "--preview-name", "pr-7"], cli),
    ).toBe(1);
    expect(pushes).toEqual([]);
    expect(runs).toEqual([]);
    expect(logs[logs.length - 1]).toContain("ignores --preview-name");
  });
});

describe("deploymentFlags", () => {
  const flags = (env: Record<string, string>, previewName?: string) =>
    deploymentFlags(fake(app({}), { env }).cli, previewName);

  test("a deployment's own deploy key selects it", () => {
    expect(flags({ CONVEX_DEPLOY_KEY: "prod:happy-cat-123|secret" })).toEqual([]);
    expect(flags({ CONVEX_DEPLOY_KEY: "dev:happy-cat-123|secret" })).toEqual([]);
    expect(flags({ CONVEX_DEPLOY_KEY: "preview:happy-cat-123|secret" })).toEqual([]);
  });

  test("a project's preview deploy key needs --preview-name", () => {
    const key = { CONVEX_DEPLOY_KEY: "preview:team:project|secret" };
    expect(() => flags(key)).toThrow("pass --preview-name");
    expect(flags(key, "pr-7")).toEqual(["--preview-name", "pr-7"]);
  });

  test("without a deploy key, a deploy's calls go to production", () => {
    expect(flags({})).toEqual(["--prod"]);
    expect(flags({}, "pr-7")).toEqual(["--preview-name", "pr-7"]);
    expect(flags({ CONVEX_DEPLOY_KEY: "project:team:project|secret" })).toEqual(["--prod"]);
  });

  test("reads the deploy key from .env.local, and the environment wins", () => {
    const cwd = app({ ".env.local": "CONVEX_DEPLOY_KEY=preview:team:project|secret\n" });
    expect(() => deploymentFlags(fake(cwd).cli, undefined)).toThrow("pass --preview-name");
    const env = { CONVEX_DEPLOY_KEY: "prod:happy-cat-123|secret" };
    expect(deploymentFlags(fake(cwd, { env }).cli, undefined)).toEqual([]);
  });
});
