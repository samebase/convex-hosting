// @vitest-environment node
// The CLI runs in Node; the edge-runtime environment of the other tests has no `process.execPath`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { deploymentSelector, type Cli } from "./convex.js";
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
 * A fake `Cli`: `npx convex run` answers like a deployment with the component, the build calls
 * `build`, and `npx convex deploy` or `npx convex dev --once` calls `push`. No processes, no
 * network. `events` lists the builds, the probes, the function calls, and the pushes in order.
 */
function fake(
  cwd: string,
  options: {
    env?: Record<string, string>;
    installed?: () => boolean;
    /** The stored file id of each sha256 that `knownFiles` knows. */
    known?: Record<string, string>;
    build?: () => Promise<number>;
    push?: (cli: Cli, args: string[], signal: AbortSignal) => Promise<number>;
  } = {},
) {
  const runs: string[][] = [];
  const pushes: string[][] = [];
  const builds: string[] = [];
  const events: string[] = [];
  const stored = new Map<string, string>();
  const logs: string[] = [];
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
        events.push("probe");
        return (options.installed?.() ?? true)
          ? ok(null)
          : { exitCode: 1, stdout: "", stderr: MISSING };
      }
      events.push(args[3]);
      const fnArgs = JSON.parse(args[4]);
      switch (args[3]) {
        case "lib:generateUploadUrls":
          return ok(Array.from({ length: fnArgs.count }, (_, i) => `https://upload/${i}`));
        case "lib:knownFiles":
          return ok(
            fnArgs.sha256s.flatMap((sha256: string) => {
              const storageId = options.known?.[sha256];
              return storageId === undefined ? [] : [{ sha256, storageId }];
            }),
          );
        default:
          return ok(null);
      }
    },
    convexInherited: async (args, signal) => {
      pushes.push(args);
      events.push(`push: ${args[0]}`);
      return (await options.push?.(cli, args, signal)) ?? 0;
    },
    shell: async (command) => {
      builds.push(command);
      events.push("build");
      return (await options.build?.()) ?? 0;
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
  return { cli, runs, pushes, builds, events, stored, logs, calls, callArgs };
}

/**
 * Answers the `heartbeat` calls of `cli` in turn: `null` succeeds, a string fails with it as the
 * standard error. Later calls succeed.
 */
function answerHeartbeats(cli: Cli, answers: (string | null)[]) {
  const run = cli.convex;
  cli.convex = async (args) => {
    const result = await run(args);
    if (args[3] !== "lib:heartbeat") return result;
    const stderr = answers.shift() ?? null;
    return stderr === null ? result : { exitCode: 1, stdout: "", stderr };
  };
}

/** The standard error of `npx convex run lib:heartbeat` when the component's `holdLock` fails. */
function lostLockError(message: string) {
  return `✖ Failed to run function "lib:heartbeat":\nConvexError: [Request ID: 1] Server Error\nUncaught ConvexError: ${message}\n    at holdLock (lib.ts:89:2)`;
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

const DEV = ["dev", "--build", "vite build", "--dist", "dist"];
const DEPLOY = ["deploy", "--build", "vite build", "--dist", "dist"];

afterEach(() => {
  vi.useRealTimers();
});

describe("dev", () => {
  test("builds, uploads, writes the version file, pushes with npx convex dev --once, then finishDeploy", async () => {
    const cwd = app(site);
    let pushedVersionId: string | undefined;
    const { cli, events, builds, pushes, runs, callArgs } = fake(cwd, {
      push: async () => {
        pushedVersionId = writtenVersionId(cwd);
        return 0;
      },
    });
    expect(await main(DEV, cli)).toBe(0);

    expect(builds).toEqual(["vite build"]);
    expect(events).toEqual([
      "build",
      "probe",
      "lib:generateUploadUrls",
      "lib:createVersion",
      "lib:knownFiles",
      "lib:generateUploadUrls",
      "lib:recordFiles",
      "lib:finishVersion",
      "push: dev",
      "lib:finishDeploy",
    ]);
    expect(pushes).toEqual([["dev", "--once"]]);
    // The development deployment is the default of every Convex command.
    expect(runs.flat().filter((arg) => arg === "--prod" || arg === "--preview-name")).toEqual([]);
    const versionId = writtenVersionId(cwd);
    expect(pushedVersionId).toBe(versionId);
    expect(callArgs("lib:createVersion")[0].versionId).toBe(versionId);
    expect(callArgs("lib:finishDeploy")).toEqual([{ versionId }]);
  });

  test("on a first install, writes the version file, pushes, then uploads", async () => {
    const cwd = app(site);
    let pushed = false;
    const { cli, events, callArgs } = fake(cwd, {
      installed: () => pushed,
      push: async () => {
        expect(existsSync(join(cwd, VERSION_FILE))).toBe(true);
        pushed = true;
        return 0;
      },
    });
    expect(await main(DEV, cli)).toBe(0);
    expect(events.slice(0, 5)).toEqual([
      "build",
      "probe",
      "push: dev",
      "probe",
      "lib:generateUploadUrls",
    ]);
    expect(existsSync(join(cwd, ".convex-hosting", "first-install"))).toBe(false);
    const versionId = writtenVersionId(cwd);
    expect(callArgs("lib:createVersion")[0].versionId).toBe(versionId);
    expect(callArgs("lib:finishDeploy")).toEqual([{ versionId }]);
  });

  test("a failed build stops before the upload", async () => {
    const { cli, events, logs } = fake(app(site), { build: async () => 2 });
    expect(await main(DEV, cli)).toBe(1);
    // `releaseLock` has nothing to release.
    expect(events).toEqual(["build", "lib:releaseLock"]);
    expect(logs[logs.length - 1]).toBe("The build failed with exit code 2.");
  });

  test("a failed push releases the lock and keeps the version", async () => {
    const cwd = app(site);
    const { cli, callArgs, logs } = fake(cwd, { push: async () => 1 });
    expect(await main(DEV, cli)).toBe(1);
    expect(callArgs("lib:releaseLock")).toEqual([{ versionId: writtenVersionId(cwd) }]);
    expect(callArgs("lib:finishDeploy")).toEqual([]);
    expect(logs[logs.length - 1]).toBe("npx convex dev --once failed with exit code 1.");
  });

  test("calls heartbeat every 30 seconds while a long page of files uploads", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cwd = app(site);
    const { cli, calls, callArgs } = fake(cwd);
    const storeFile = cli.fetch;
    let slow = true;
    cli.fetch = async (url, init) => {
      // The first file of the page takes 65 seconds; the config is stored before `createVersion`.
      if (calls().includes("lib:createVersion") && slow) {
        slow = false;
        await vi.advanceTimersByTimeAsync(65_000);
      }
      return await storeFile(url, init);
    };
    expect(await main(DEV, cli)).toBe(0);
    const versionId = writtenVersionId(cwd);
    expect(callArgs("lib:heartbeat")).toEqual([{ versionId }, { versionId }]);
    expect(calls().indexOf("lib:heartbeat")).toBeGreaterThan(calls().indexOf("lib:createVersion"));
  });

  test("refuses --preview-name: dev targets the development deployment", async () => {
    const { cli, events, logs } = fake(app(site));
    expect(await main([...DEV, "--preview-name", "pr-7"], cli)).toBe(1);
    expect(events).toEqual([]);
    expect(logs[logs.length - 1]).toContain("--preview-name is a deploy option");
  });
});

describe("upload", () => {
  const upload = (...args: string[]) => ["upload", "--dist", "dist", "--version-id", "v1", ...args];

  test("uploads the files that .assetsignore keeps, with the config from _headers and _redirects", async () => {
    const cwd = app(site);
    const { cli, calls, callArgs, stored, runs } = fake(cwd);
    expect(await main(upload("--not-found-handling", "single-page-application"), cli)).toBe(0);

    expect(calls()).toEqual([
      "probe",
      "lib:generateUploadUrls",
      "lib:createVersion",
      "lib:knownFiles",
      "lib:generateUploadUrls",
      "lib:recordFiles",
      "lib:finishVersion",
    ]);
    // Inside `npx convex deploy`, every run goes to production.
    expect(runs.every((args) => args.includes("--prod"))).toBe(true);

    expect(callArgs("lib:createVersion")).toEqual([{ versionId: "v1", configId: "storage-0" }]);
    expect(JSON.parse(stored.get("storage-0") ?? "")).toEqual({
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
    const [{ entries }] = callArgs("lib:recordFiles");
    expect(entries.map((entry: { path: string }) => entry.path).sort()).toEqual([
      "/assets/app.js",
      "/copy.html",
      "/index.html",
    ]);
    const home = entries.find((entry: { path: string }) => entry.path === "/index.html");
    expect(home).toEqual({
      path: "/index.html",
      sha256: createHash("sha256").update("<h1>Home</h1>").digest("hex"),
      contentType: "text/html; charset=utf-8",
      storageId: expect.stringMatching(/^storage-/),
    });
    // Two entries with the same bytes share one stored file.
    expect(callArgs("lib:generateUploadUrls")[1]).toEqual({ count: 2 });
    expect(entries.find((entry: { path: string }) => entry.path === "/copy.html").storageId).toBe(
      home.storageId,
    );

    expect(versionFile(cwd)).toBe('export const versionId = "v1";\n');
    expect(readFileSync(join(cwd, ".convex-hosting", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("does not upload the files that knownFiles knows, and records them with their stored file", async () => {
    const home = createHash("sha256").update("<h1>Home</h1>").digest("hex");
    const { cli, calls, callArgs } = fake(app(site), { known: { [home]: "known-home" } });
    expect(await main(upload(), cli)).toBe(0);
    expect(calls().filter((name) => name === "lib:recordFiles")).toHaveLength(2);
    const [known, uploaded] = callArgs("lib:recordFiles");
    expect(known.entries.map((entry: { path: string }) => entry.path).sort()).toEqual([
      "/copy.html",
      "/index.html",
    ]);
    expect(
      known.entries.every((entry: { storageId: string }) => entry.storageId === "known-home"),
    ).toBe(true);
    // Only the script is uploaded.
    expect(callArgs("lib:generateUploadUrls")[1]).toEqual({ count: 1 });
    expect(uploaded.entries.map((entry: { path: string }) => entry.path)).toEqual([
      "/assets/app.js",
    ]);
  });

  test("requires --version-id: it is the step inside deploy", async () => {
    const { cli, runs, logs } = fake(app(site));
    expect(await main(["upload", "--dist", "dist"], cli)).toBe(1);
    expect(runs).toEqual([]);
    expect(logs[logs.length - 1]).toMatch(/^Usage:/);
    expect(logs[logs.length - 1]).not.toContain("upload");
  });

  test("any other failure of the probe is an error", async () => {
    const cwd = app(site);
    const { cli, logs } = fake(cwd);
    cli.convex = async () => ({ exitCode: 1, stdout: "", stderr: "✖ Not logged in." });
    expect(await main(upload(), cli)).toBe(1);
    expect(logs).toContain("✖ Not logged in.");
    expect(existsSync(join(cwd, VERSION_FILE))).toBe(false);
  });

  test("refuses a file above 25 MiB and names it", async () => {
    const cwd = app({ "dist/index.html": "", "dist/big.bin": "x".repeat(25 * 1024 * 1024 + 1) });
    const { cli, logs, runs } = fake(cwd);
    expect(await main(upload(), cli)).toBe(1);
    expect(logs[logs.length - 1]).toContain(join(cwd, "dist", "big.bin"));
    expect(runs).toEqual([]);
  });

  test("refuses a config above 900 KiB and names the file", async () => {
    const long = "x".repeat(450);
    const redirects = Array.from({ length: 2000 }, (_, i) => `/${i}${long} /${i}${long}-to 301`);
    const cwd = app({ "dist/index.html": "", "dist/_redirects": redirects.join("\n") });
    const { cli, logs, runs } = fake(cwd);
    expect(await main(upload(), cli)).toBe(1);
    expect(logs[logs.length - 1]).toContain(join(cwd, "dist", "_redirects"));
    expect(runs).toEqual([]);
  });
});

describe("deploy", () => {
  test("runs the build and the upload inside npx convex deploy, then finishDeploy", async () => {
    const cwd = app(site);
    const { cli, pushes, runs, callArgs } = fake(cwd, { push: innerUpload });
    expect(await main(DEPLOY, cli)).toBe(0);

    expect(pushes).toHaveLength(1);
    expect(pushes[0].slice(0, 2)).toEqual(["deploy", "--cmd"]);
    expect(pushes[0][2]).toMatch(
      /^vite build && '.+' '.+' 'upload' '--dist' '[^']+' '--version-id' '/,
    );
    expect(pushes[0][2]).toContain("'--dist' 'dist'");
    // `npx convex deploy` goes to production by default and has no --prod flag; every run gets it.
    expect(pushes[0]).not.toContain("--prod");
    expect(runs.every((args) => args.includes("--prod"))).toBe(true);
    const versionId = writtenVersionId(cwd);
    expect(callArgs("lib:createVersion")[0].versionId).toBe(versionId);
    expect(callArgs("lib:finishDeploy")).toEqual([{ versionId }]);
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
    expect(await main(DEPLOY, cli)).toBe(0);

    expect(calls().slice(0, 3)).toEqual(["probe", "probe", "lib:generateUploadUrls"]);
    expect(existsSync(join(cwd, ".convex-hosting", "first-install"))).toBe(false);
    const versionId = writtenVersionId(cwd);
    expect(callArgs("lib:finishDeploy")).toEqual([{ versionId }]);
  });

  test("a failed push releases the lock and keeps the version", async () => {
    const cwd = app(site);
    const { cli, callArgs, logs } = fake(cwd, {
      push: async (cli, args) => {
        await innerUpload(cli, args);
        return 1;
      },
    });
    expect(await main(DEPLOY, cli)).toBe(1);
    expect(callArgs("lib:releaseLock")).toEqual([{ versionId: writtenVersionId(cwd) }]);
    expect(callArgs("lib:finishDeploy")).toEqual([]);
    expect(logs[logs.length - 1]).toBe("npx convex deploy failed with exit code 1.");
  });

  test("calls heartbeat every 30 seconds while the push runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { cli, callArgs } = fake(app(site), {
      push: async () => {
        await vi.advanceTimersByTimeAsync(65_000);
        return 0;
      },
    });
    expect(await main(DEPLOY, cli)).toBe(0);
    const heartbeats = callArgs("lib:heartbeat");
    expect(heartbeats).toHaveLength(2);
    const { versionId } = heartbeats[0];
    expect(callArgs("lib:finishDeploy")).toEqual([{ versionId }]);
  });

  test("a heartbeat that reports a lost lock kills the push, once the lock was held", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const lost = "The deploy of version v1 lost its lock: a deploy of version v2 holds it.";
    let killedAfter = 0;
    const { cli, calls, logs } = fake(app(site), {
      // The push runs until its signal kills it.
      push: (_cli, _args, signal) => {
        const killedPush = new Promise<number>((_, reject) =>
          signal.addEventListener("abort", () => {
            killedAfter = calls().length;
            reject(signal.reason);
          }),
        );
        void vi.advanceTimersByTimeAsync(90_000);
        return killedPush;
      },
    });
    // Before the upload's `createVersion`, the lock is not this deploy's yet, and a heartbeat gets
    // the same answer. It counts only after a heartbeat succeeded.
    answerHeartbeats(cli, [
      lostLockError("The deploy of version v1 lost its lock."),
      null,
      lostLockError(lost),
    ]);
    expect(await main(DEPLOY, cli)).toBe(1);
    expect(killedAfter).toBe(3);
    expect(logs[logs.length - 1]).toBe(lost);
    // Nothing is deleted; the lock is not this deploy's to release.
    expect(calls()).toEqual(["lib:heartbeat", "lib:heartbeat", "lib:heartbeat", "lib:releaseLock"]);
  });

  test("other heartbeat errors are ignored", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { cli, calls } = fake(app(site), {
      push: async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        return 0;
      },
    });
    answerHeartbeats(cli, [null, "✖ Not logged in."]);
    expect(await main(DEPLOY, cli)).toBe(0);
    expect(calls()).toEqual(["lib:heartbeat", "lib:heartbeat", "lib:finishDeploy"]);
  });

  test("passes --preview-name to npx convex deploy and to every run", async () => {
    const { cli, pushes, runs } = fake(app(site), { push: innerUpload });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], cli)).toBe(0);
    expect(pushes[0].slice(-2)).toEqual(["--preview-name", "pr-7"]);
    expect(runs.every((args) => args.slice(-2).join(" ") === "--preview-name pr-7")).toBe(true);
  });

  test("passes no selector to a self-hosted deployment", async () => {
    const env = { CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210" };
    const { cli, pushes, runs } = fake(app(site), { env, push: innerUpload });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], cli)).toBe(0);
    expect(pushes[0]).toHaveLength(3);
    expect(runs.flat().filter((arg) => arg === "--prod" || arg === "--preview-name")).toEqual([]);
  });
});

describe("deploymentSelector", () => {
  const selector = (files: Record<string, string>, previewName?: string) =>
    deploymentSelector(fake(app(files)).cli, previewName);

  test("--preview-name when given, else --prod", () => {
    expect(selector({})).toEqual(["--prod"]);
    expect(selector({}, "pr-7")).toEqual(["--preview-name", "pr-7"]);
  });

  test("a deploy key changes nothing: the Convex CLI lets it win over the selector", () => {
    expect(selector({ ".env.local": "CONVEX_DEPLOY_KEY=prod:happy-cat-123|secret\n" })).toEqual([
      "--prod",
    ]);
  });

  test("a self-hosted deployment takes no selector", () => {
    const selfHosted = { ".env.local": "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\n" };
    expect(selector(selfHosted)).toEqual([]);
    expect(selector(selfHosted, "pr-7")).toEqual([]);
  });
});
