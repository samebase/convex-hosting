// @vitest-environment node
// The CLI runs in Node; the edge-runtime environment of the other tests has no `process.execPath`.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { deploymentSelector, type Cli } from "./convex.js";
import { main, VERSION_FILE } from "./main.js";

/** What `npx convex run --component <name> --inline-query` prints when the component is missing. */
const missing = (component: string) =>
  `✖ Component path "${component}" was not found.\n\nThis deployment has no mounted components.`;

/** The site URL that the fake deployment gives its functions in `CONVEX_SITE_URL`. */
const SITE_URL = "https://happy-cat-123.convex.site";

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

/** What a `npx convex run` call is: the probe, the site URL query, or a function's name. */
const callName = (args: string[]) =>
  args.includes("process.env.CONVEX_SITE_URL")
    ? "site url"
    : args.includes("--inline-query")
      ? "probe"
      : args[3];

/**
 * A fake `Cli`: `npx convex run` answers like a deployment with the component, the build calls
 * `build`, and `npx convex deploy` or `npx convex run --push` calls `push`. No processes, no
 * network. `events` lists the builds, the probes, the site URL queries, the function calls, and the
 * pushes in order.
 */
function fake(
  cwd: string,
  options: {
    env?: Record<string, string>;
    installed?: () => boolean;
    /** The stored file id of each sha256 that `knownFiles` knows. */
    known?: Record<string, string>;
    build?: () => Promise<number>;
    push?: (cli: Cli, args: string[]) => Promise<number>;
    /** What `npx convex dev --once` writes to `.env.local`; `null` writes nothing. */
    deployment?: string | null;
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
      if (callName(args) === "site url") {
        events.push("site url");
        return ok(SITE_URL);
      }
      if (args.includes("--inline-query")) {
        events.push("probe");
        return (options.installed?.() ?? true)
          ? ok(null)
          : { exitCode: 1, stdout: "", stderr: missing(args[args.indexOf("--component") + 1]) };
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
    convexInherited: async (args) => {
      pushes.push(args);
      events.push(`push: ${args[0]}`);
      if (args[0] === "dev" && options.deployment !== null) {
        writeFileSync(
          join(cwd, ".env.local"),
          `CONVEX_DEPLOYMENT=${options.deployment ?? "dev:happy-cat-123"}\n`,
        );
      }
      return (await options.push?.(cli, args)) ?? 0;
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
  const calls = () => runs.map(callName);
  const callArgs = (name: string) =>
    runs.filter((args) => args[3] === name).map((args) => JSON.parse(args[4]));
  return { cli, runs, pushes, builds, events, stored, logs, calls, callArgs };
}

/** Runs the upload that `deploy` put in `--cmd`, the way the shell would. */
function innerUpload(cli: Cli, args: string[]) {
  const command = args[args.indexOf("--cmd") + 1];
  const quoted = [...command.slice(Math.max(0, command.lastIndexOf("&&"))).matchAll(/'([^']*)'/g)];
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

const DEPLOY = ["deploy", "--build", "vite build", "--dist", "dist"];
const DEV = [...DEPLOY, "--dev"];

/** A selector flag in any Convex command. */
const selectors = (commands: string[][]) =>
  commands.flat().filter((arg) => arg === "--prod" || arg === "--preview-name");

describe("help", () => {
  test("no arguments, --help, and -h print the usage and exit 0", async () => {
    for (const args of [[], ["--help"], ["-h"], ["deploy", "--help"]]) {
      const { cli, logs, events } = fake(app(site));
      expect(await main(args, cli)).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^Usage:\n {2}convex-hosting deploy /);
      expect(events).toEqual([]);
    }
  });
});

describe("deploy --dev", () => {
  test("builds, uploads, writes the version file, pushes with npx convex run --push, and reports the site URL", async () => {
    const cwd = app(site);
    let pushedVersionId: string | undefined;
    const { cli, events, builds, pushes, runs, logs } = fake(cwd, {
      push: async () => {
        pushedVersionId = writtenVersionId(cwd);
        return 0;
      },
    });
    expect(await main(DEV, cli)).toBe(0);

    expect(builds).toEqual(["vite build"]);
    // Only the site URL query runs after the push.
    expect(events).toEqual([
      "build",
      "probe",
      "lib:generateUploadUrls",
      "lib:createVersion",
      "lib:knownFiles",
      "lib:generateUploadUrls",
      "lib:recordFiles",
      "lib:finishVersion",
      "push: run",
      "site url",
    ]);
    // An inline query at the app's root, which exists before a first install.
    expect(pushes).toEqual([["run", "--push", "--inline-query", "null"]]);
    // The development deployment is the default of `npx convex run`.
    expect(selectors(runs)).toEqual([]);
    const versionId = writtenVersionId(cwd);
    expect(pushedVersionId).toBe(versionId);
    expect(logs[logs.length - 1]).toBe(`Deployed version ${versionId} to ${SITE_URL}.`);
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
      "push: run",
      "probe",
      "lib:generateUploadUrls",
    ]);
    expect(events.slice(-2)).toEqual(["lib:finishVersion", "site url"]);
    expect(existsSync(join(cwd, ".convex-hosting", "first-install"))).toBe(false);
    expect(callArgs("lib:createVersion")[0].versionId).toBe(writtenVersionId(cwd));
  });

  test("a failed build stops before the upload", async () => {
    const { cli, events, logs } = fake(app(site), { build: async () => 2 });
    expect(await main(DEV, cli)).toBe(1);
    expect(events).toEqual(["build"]);
    expect(logs[logs.length - 1]).toBe("The build failed with exit code 2.");
  });

  test("a failed push fails the deploy", async () => {
    const { cli, events, logs } = fake(app(site), { push: async () => 1 });
    expect(await main(DEV, cli)).toBe(1);
    expect(events[events.length - 1]).toBe("push: run");
    expect(logs[logs.length - 1]).toBe("npx convex run --push failed with exit code 1.");
  });

  test("refuses --dev with --preview-name", async () => {
    const { cli, events, logs } = fake(app(site));
    expect(await main([...DEV, "--preview-name", "pr-7"], cli)).toBe(1);
    expect(events).toEqual([]);
    expect(logs[logs.length - 1]).toBe("--dev and --preview-name exclude each other.");
  });
});

describe("init", () => {
  const INIT = ["init", "--build", "vite build", "--dist", "dist"];

  test("configures with npx convex dev --once, whose push may fail, then deploys, then says to run npx convex dev", async () => {
    const cwd = app(site);
    const { cli, events, pushes, logs } = fake(cwd, {
      push: async (_cli, args) => (args[0] === "dev" ? 1 : 0),
    });
    expect(await main(INIT, cli)).toBe(0);
    expect(pushes[0]).toEqual(["dev", "--once"]);
    expect(events.slice(0, 2)).toEqual(["push: dev", "build"]);
    expect(events.slice(-2)).toEqual(["push: run", "site url"]);
    expect(existsSync(join(cwd, VERSION_FILE))).toBe(true);
    expect(logs[logs.length - 1]).toBe("Now run npx convex dev.");
  });

  test("an empty CONVEX_DEPLOYMENT is unset, as the Convex CLI reads it", async () => {
    const { cli, events } = fake(app({ ...site, ".env.local": "CONVEX_DEPLOYMENT=\n" }));
    expect(await main(INIT, cli)).toBe(0);
    expect(events[0]).toBe("push: dev");
  });

  test("fails when npx convex dev --once configured no deployment", async () => {
    const { cli, events, logs } = fake(app(site), { deployment: null });
    expect(await main(INIT, cli)).toBe(1);
    expect(events).toEqual(["push: dev"]);
    expect(logs[logs.length - 1]).toBe("npx convex dev --once configured no deployment.");
  });

  test("refuses, before any process, a deploy key, anonymous mode, and a deployment that is not a cloud dev one", async () => {
    const cases: [Record<string, string>, Record<string, string>][] = [
      [{ CONVEX_DEPLOY_KEY: "prod:x|y" }, {}],
      [{ CONVEX_AGENT_MODE: "anonymous" }, {}],
      [{}, { ".env.local": "CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n" }],
      [{}, { ".env.local": "CONVEX_DEPLOYMENT=local:happy-cat-123\n" }],
      [{ CONVEX_DEPLOYMENT: "prod:happy-cat-123" }, {}],
    ];
    for (const [env, files] of cases) {
      const { cli, events, logs } = fake(app({ ...site, ...files }), { env });
      expect(await main(INIT, cli)).toBe(1);
      expect(events).toEqual([]);
      expect(logs[logs.length - 1]).toContain("init sets up a cloud development deployment");
    }
  });

  test("refuses a local deployment chosen at the configure prompt, and deploys nothing", async () => {
    const { cli, events } = fake(app(site), { deployment: "anonymous:anonymous-agent" });
    expect(await main(INIT, cli)).toBe(1);
    expect(events).toEqual(["push: dev"]);
  });

  test("refuses --dev and --preview-name", async () => {
    for (const extra of [["--dev"], ["--preview-name", "pr-7"]]) {
      const { cli, events, logs } = fake(app(site));
      expect(await main([...INIT, ...extra], cli)).toBe(1);
      expect(events).toEqual([]);
      expect(logs[logs.length - 1]).toMatch(/^Usage:/);
    }
  });
});

describe("deploy without --build", () => {
  test("--dev uploads the folder as it is, then pushes", async () => {
    const { cli, events, builds } = fake(app(site));
    expect(await main(["deploy", "--dev", "--dist", "dist"], cli)).toBe(0);
    expect(builds).toEqual([]);
    expect(events[0]).toBe("probe");
    expect(events.slice(-2)).toEqual(["push: run", "site url"]);
  });

  test("production runs only the upload inside npx convex deploy --cmd", async () => {
    const { cli, pushes, events } = fake(app(site), { push: innerUpload });
    expect(await main(["deploy", "--dist", "dist"], cli)).toBe(0);
    expect(pushes[0][2]).toMatch(/^'.+' '.+' 'upload' '--dist' 'dist' '--version-id' '/);
    expect(events[0]).toBe("push: deploy");
    expect(events.slice(-2)).toEqual(["lib:finishVersion", "site url"]);
  });
});

describe("deploy", () => {
  test("runs the build and the upload inside npx convex deploy, then reports the site URL", async () => {
    const cwd = app(site);
    const { cli, pushes, runs, events, callArgs } = fake(cwd, { push: innerUpload });
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
    // The upload runs inside the push, and only the site URL query runs after it.
    expect(events[0]).toBe("push: deploy");
    expect(events.slice(-2)).toEqual(["lib:finishVersion", "site url"]);
    expect(callArgs("lib:createVersion")[0].versionId).toBe(writtenVersionId(cwd));
  });

  test("on a first install, uploads after the push", async () => {
    const cwd = app(site);
    let pushed = false;
    const { cli, calls } = fake(cwd, {
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
    expect(calls().slice(-2)).toEqual(["lib:finishVersion", "site url"]);
    expect(existsSync(join(cwd, ".convex-hosting", "first-install"))).toBe(false);
  });

  test("a failed push fails the deploy", async () => {
    const { cli, events, logs } = fake(app(site), {
      push: async (cli, args) => {
        await innerUpload(cli, args);
        return 1;
      },
    });
    expect(await main(DEPLOY, cli)).toBe(1);
    expect(events[events.length - 1]).toBe("lib:finishVersion");
    expect(logs[logs.length - 1]).toBe("npx convex deploy failed with exit code 1.");
  });

  test("--preview-name goes to npx convex deploy and to every run", async () => {
    const { cli, pushes, runs } = fake(app(site), { push: innerUpload });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], cli)).toBe(0);
    expect(pushes[0].slice(-2)).toEqual(["--preview-name", "pr-7"]);
    expect(pushes[0][2]).toContain("'--preview-name' 'pr-7'");
    expect(runs.every((args) => args.slice(-2).join(" ") === "--preview-name pr-7")).toBe(true);
  });

  test("appends the site URL to $GITHUB_OUTPUT when it is set", async () => {
    const cwd = app(site);
    const output = join(cwd, "github-output");
    writeFileSync(output, "earlier=1\n");
    const { cli, runs } = fake(cwd, { env: { GITHUB_OUTPUT: output }, push: innerUpload });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], cli)).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`earlier=1\nurl=${SITE_URL}\n`);
    // The query goes to the deployment of the deploy.
    expect(runs[runs.length - 1].slice(-2)).toEqual(["--preview-name", "pr-7"]);
  });

  test("names the probe's output when the push did not install the component", async () => {
    const { cli, logs } = fake(app(site), { installed: () => false, push: innerUpload });
    expect(await main([...DEPLOY, "--component", "hostin"], cli)).toBe(1);
    const message = logs[logs.length - 1];
    expect(message).toContain('The component "hostin" is not installed after the push.');
    expect(message).toContain("This deployment has no mounted components.");
  });

  test("passes no selector to a self-hosted deployment", async () => {
    const env = { CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210" };
    const { cli, pushes, runs } = fake(app(site), { env, push: innerUpload });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], cli)).toBe(0);
    expect(pushes[0]).toHaveLength(3);
    expect(selectors(runs)).toEqual([]);
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
    // Inside `npx convex deploy` to production, every run gets --prod.
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

  test("follows a symbolic link to a file, and skips a link to nothing", async () => {
    const cwd = app({ "dist/index.html": "<h1>Home</h1>", "shared/logo.svg": "<svg/>" });
    symlinkSync(join(cwd, "shared", "logo.svg"), join(cwd, "dist", "logo.svg"));
    symlinkSync(join(cwd, "missing.txt"), join(cwd, "dist", "gone.txt"));
    const { cli, callArgs, logs } = fake(cwd);
    expect(await main(upload(), cli)).toBe(0);
    const [{ entries }] = callArgs("lib:recordFiles");
    expect(entries.map((entry: { path: string }) => entry.path).sort()).toEqual([
      "/index.html",
      "/logo.svg",
    ]);
    expect(logs).toContain(`Skipped ${join(cwd, "dist", "gone.txt")}: a symbolic link to nothing.`);
  });

  test("uploads a linked sibling folder under both paths, and skips a link to dist itself", async () => {
    const cwd = app({ "dist/assets/app.js": "console.log(1)" });
    // `alias` comes before `assets` in the listing.
    symlinkSync(join(cwd, "dist", "assets"), join(cwd, "dist", "alias"));
    symlinkSync(join(cwd, "dist"), join(cwd, "dist", "loop"));
    const { cli, callArgs, logs } = fake(cwd);
    expect(await main(upload(), cli)).toBe(0);
    const [{ entries }] = callArgs("lib:recordFiles");
    expect(entries.map((entry: { path: string }) => entry.path).sort()).toEqual([
      "/alias/app.js",
      "/assets/app.js",
    ]);
    expect(logs).toContain(
      `Skipped ${join(cwd, "dist", "loop")}: a link to a folder that contains it.`,
    );
  });

  test("an ignored link to a folder does not hide the folder it points to", async () => {
    const cwd = app({
      "dist/assets/app.js": "console.log(1)",
      "dist/.assetsignore": "a-ignored/\n",
    });
    // `a-ignored` comes before `assets` in the listing.
    symlinkSync(join(cwd, "dist", "assets"), join(cwd, "dist", "a-ignored"));
    const { cli, callArgs } = fake(cwd);
    expect(await main(upload(), cli)).toBe(0);
    const [{ entries }] = callArgs("lib:recordFiles");
    expect(entries.map((entry: { path: string }) => entry.path)).toEqual(["/assets/app.js"]);
  });

  test("names a --dist folder that does not exist", async () => {
    const cwd = app(site);
    const { cli, logs, runs } = fake(cwd);
    expect(await main(["upload", "--dist", "build", "--version-id", "v1"], cli)).toBe(1);
    expect(logs[logs.length - 1]).toBe(`The --dist folder ${join(cwd, "build")} does not exist.`);
    expect(runs).toEqual([]);
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

describe("deploymentSelector", () => {
  const selfHosted = { ".env.local": "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\n" };
  const select = (files: Record<string, string>) => ({
    production: deploymentSelector(fake(app(files)).cli, { kind: "production" }),
    preview: deploymentSelector(fake(app(files)).cli, { kind: "preview", name: "pr-7" }),
    dev: deploymentSelector(fake(app(files)).cli, { kind: "dev" }),
  });

  test("production gets --prod, a preview --preview-name, and the development deployment none", () => {
    expect(select({})).toEqual({
      production: ["--prod"],
      preview: ["--preview-name", "pr-7"],
      dev: [],
    });
  });

  test("a deploy key changes nothing: the Convex CLI lets it win over the selector", () => {
    const keyed = { ".env.local": "CONVEX_DEPLOY_KEY=prod:happy-cat-123|secret\n" };
    expect(select(keyed)).toEqual(select({}));
  });

  test("a self-hosted deployment takes no selector", () => {
    expect(select(selfHosted)).toEqual({ production: [], preview: [], dev: [] });
  });
});
