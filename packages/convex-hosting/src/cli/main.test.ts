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
import { lookup, MARK_HEADER, MARK_PATH, storageUrl, type Site } from "../client/manifest.js";
import { deploymentSelector, type Cli } from "./convex.js";
import { main, VERSION_FILE } from "./main.js";

/** What `npx convex run --component <name> --inline-query` prints when the component is missing. */
const missing = (component: string) =>
  `✖ Component path "${component}" was not found.\n\nThis deployment has no mounted components.`;

/** The site URL that the fake deployment gives its functions in `CONVEX_SITE_URL`. */
const SITE_URL = "https://happy-cat-123.convex.site";

/** The fake deployment's `CONVEX_CLOUD_URL`, the origin of its storage URLs. */
const CLOUD_URL = "https://happy-cat-123.convex.cloud";

/** The storage URL that the fake deployment gives a stored file. */
const fileUrl = (storageId: string) => `${CLOUD_URL}/api/storage/${storageId}?component=c1`;

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
 * What a `npx convex run` call is: the probe, the site URL query, the storage URL query, or a
 * function's name.
 */
const callName = (args: string[]) =>
  args.includes("process.env.CONVEX_SITE_URL")
    ? "site url"
    : args.some((arg) => arg.includes("ctx.storage.getUrl"))
      ? "urls"
      : args.includes("--inline-query")
        ? "probe"
        : args[3];

/**
 * A fake `Cli`: `npx convex run` answers like a deployment with the component, the build calls
 * `build`, `npx convex deploy` or `npx convex run --push` calls `push`, and the site answers the
 * mark request with `mark`. No processes, no network. `events` lists the builds, the probes, the
 * site URL queries, the storage URL queries, the function calls, the pushes, and the marks in
 * order.
 */
function fake(
  cwd: string,
  options: {
    env?: Record<string, string>;
    installed?: () => boolean;
    /** The stored file id of each sha256 that `knownFiles` knows. */
    known?: Record<string, string>;
    /** What the Convex CLI prints for each function name that fails. */
    failing?: Record<string, string>;
    build?: () => Promise<number>;
    push?: (cli: Cli, args: string[]) => Promise<number>;
    /** The site's answer to the mark request; by default it marks the version of the file. */
    mark?: (token: string | null, init: RequestInit | undefined) => Promise<Response>;
  } = {},
) {
  const runs: string[][] = [];
  const pushes: string[][] = [];
  const builds: string[] = [];
  const events: string[] = [];
  const stored = new Map<string, string>();
  /** The entries that `recordFiles` recorded, by version. */
  const recorded = new Map<string, { path: string; storageId: string }[]>();
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
      if (callName(args) === "urls") {
        events.push("urls");
        const code = args[args.indexOf("--inline-query") + 1];
        const [, versionId, after] =
          /q\.eq\("versionId", ("[^"]*")\)\.gt\("path", ("[^"]*")\)/.exec(code) ?? [];
        const take = Number(/\.take\((\d+)\)/.exec(code)?.[1]);
        const files = (recorded.get(JSON.parse(versionId)) ?? [])
          .filter(({ path }) => path > JSON.parse(after))
          .sort((a, b) => (a.path < b.path ? -1 : 1))
          .slice(0, take)
          .map(({ path, storageId }) => [path, fileUrl(storageId)]);
        return ok({ cloudUrl: CLOUD_URL, files });
      }
      if (args.includes("--inline-query")) {
        events.push("probe");
        return (options.installed?.() ?? true)
          ? ok(null)
          : { exitCode: 1, stdout: "", stderr: missing(args[args.indexOf("--component") + 1]) };
      }
      events.push(args[3]);
      const failure = options.failing?.[args[3]];
      if (failure !== undefined) return { exitCode: 1, stdout: "", stderr: failure };
      const fnArgs = JSON.parse(args[4]);
      switch (args[3]) {
        case "lib:recordFiles":
          recorded.set(fnArgs.versionId, [
            ...(recorded.get(fnArgs.versionId) ?? []),
            ...fnArgs.entries,
          ]);
          return ok(null);
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
      return (await options.push?.(cli, args)) ?? 0;
    },
    shell: async (command) => {
      builds.push(command);
      events.push("build");
      return (await options.build?.()) ?? 0;
    },
    fetch: async (url, init) => {
      if (url === SITE_URL + MARK_PATH) {
        events.push("mark");
        const token = new Headers(init?.headers).get(MARK_HEADER);
        if (options.mark !== undefined) return await options.mark(token, init);
        const site = writtenSite(cwd);
        return token === site.markToken
          ? Response.json({ versionId: site.versionId, result: "marked" })
          : new Response("<h1>Home</h1>");
      }
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
/** The site of the version file, as `convex/http.ts` imports it. */
function writtenSite(cwd: string): Site {
  const line = versionFile(cwd)
    .split("\n")
    .find((text) => text.startsWith("export const site = "));
  return JSON.parse(line?.slice("export const site = ".length, -1) ?? "null");
}

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
  test("builds, uploads, writes the version file, pushes with npx convex run --push, marks, and reports the site URL", async () => {
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
      "urls",
      "push: run",
      "site url",
      "mark",
    ]);
    // An inline query at the app's root, which exists before a first install.
    expect(pushes).toEqual([["run", "--push", "--inline-query", "null"]]);
    // The development deployment is the default of `npx convex run`.
    expect(selectors(runs)).toEqual([]);
    const versionId = writtenVersionId(cwd);
    expect(pushedVersionId).toBe(versionId);
    expect(logs[logs.length - 1]).toBe(`Deployed version ${versionId} to ${SITE_URL}.`);
  });

  test("on a first install, pushes a site without files, uploads, then pushes the site", async () => {
    const cwd = app(site);
    let pushed = false;
    const pushedFiles: boolean[] = [];
    const { cli, events, callArgs } = fake(cwd, {
      installed: () => pushed,
      push: async () => {
        pushedFiles.push(writtenSite(cwd).files !== null);
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
    expect(events.slice(-5)).toEqual([
      "lib:finishVersion",
      "urls",
      "push: run",
      "site url",
      "mark",
    ]);
    expect(pushedFiles).toEqual([false, true]);
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

describe("deploy keys and selectors", () => {
  test("--dev refuses a deploy key in the environment, before any process", async () => {
    const keys: Record<string, string>[] = [
      { CONVEX_DEPLOY_KEY: "prod:x|y" },
      { CONVEX_DEPLOYMENT_TOKEN: "dev:x|y" },
    ];
    for (const env of keys) {
      const { cli, events, logs } = fake(app(site), { env });
      expect(await main(DEV, cli)).toBe(1);
      expect(events).toEqual([]);
      expect(logs[logs.length - 1]).toContain("Unset the key.");
    }
  });

  test("--preview-name accepts a preview key and refuses any other", async () => {
    const refused = fake(app(site), { env: { CONVEX_DEPLOY_KEY: "prod:x|y" } });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], refused.cli)).toBe(1);
    expect(refused.events).toEqual([]);
    expect(refused.logs[refused.logs.length - 1]).toContain("the key set is a production key");
    const accepted = fake(app(site), {
      env: { CONVEX_DEPLOY_KEY: "preview:t:p|y" },
      push: innerUpload,
    });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], accepted.cli)).toBe(0);
  });

  test("--preview-name without a key or a login names the preview key, before any process", async () => {
    const refused = fake(app(site));
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], refused.cli)).toBe(1);
    expect(refused.events).toEqual([]);
    expect(refused.logs[refused.logs.length - 1]).toBe(
      "--preview-name needs the project's preview deploy key in CONVEX_DEPLOY_KEY (in CI, from a " +
        "secret such as CONVEX_PREVIEW_DEPLOY_KEY), or a login with the project in " +
        "CONVEX_DEPLOYMENT; neither is set.",
    );
    // A login selects the preview through the project that `npx convex dev` wrote to .env.local.
    const loggedIn = fake(app({ ...site, ".env.local": "CONVEX_DEPLOYMENT=dev:happy-cat-123\n" }), {
      push: innerUpload,
    });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], loggedIn.cli)).toBe(0);
  });
});

describe("deploy keys that are not keys", () => {
  test("never echoes a key: a legacy key has no prefix", async () => {
    const { cli, logs } = fake(app(site), { env: { CONVEX_DEPLOY_KEY: "happy-cat-123|s3cret" } });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], cli)).toBe(1);
    expect(logs[logs.length - 1]).toBe(
      "--preview-name needs a preview deploy key; the key set is not a preview key.",
    );
    expect(logs.join("\n")).not.toContain("s3cret");
  });

  test("the Convex CLI's ignore sentinel counts as no key, also over a token behind it", async () => {
    const envs: Record<string, string>[] = [
      { CONVEX_DEPLOY_KEY: "<ignore_deploy_key>" },
      { CONVEX_DEPLOY_KEY: "<ignore_deploy_key>", CONVEX_DEPLOYMENT_TOKEN: "prod:x|y" },
    ];
    for (const env of envs) {
      const { cli } = fake(app(site), { env });
      expect(await main(DEV, cli)).toBe(0);
    }
  });
});

describe("deploy reports", () => {
  test("a push that landed is reported even when the site URL cannot be read", async () => {
    const { cli, logs } = fake(app(site), { push: innerUpload });
    const convex = cli.convex;
    cli.convex = async (args) =>
      callName(args) === "site url"
        ? { exitCode: 1, stdout: "", stderr: "✖ Not logged in." }
        : convex(args);
    expect(await main(DEPLOY, cli)).toBe(1);
    expect(logs[logs.length - 1]).toMatch(
      /^Deployed version [0-9a-f-]+, but reading the site URL failed: ✖ Not logged in\.$/,
    );
  });

  test("the mark carries the site's token, so only the code of this deploy marks", async () => {
    const tokens: (string | null)[] = [];
    const cwd = app(site);
    const { cli, logs } = fake(cwd, {
      push: innerUpload,
      mark: async (token) => {
        tokens.push(token);
        return Response.json({ versionId: writtenSite(cwd).versionId, result: "marked" });
      },
    });
    expect(await main(DEPLOY, cli)).toBe(0);
    expect(tokens).toEqual([writtenSite(cwd).markToken]);
    expect(logs[logs.length - 1]).toMatch(/^Deployed version /);
  });

  test("a mark that fails or reaches other code is reported, and the deploy succeeds", async () => {
    const answers: Record<string, () => Promise<Response>> = {
      "failed: fetch failed": async () => {
        throw new TypeError("fetch failed");
      },
      "did not answer as version": async () => new Response("<h1>Home</h1>"),
    };
    for (const [message, answer] of Object.entries(answers)) {
      const { cli, logs } = fake(app(site), { push: innerUpload, mark: answer });
      expect(await main(DEPLOY, cli)).toBe(0);
      expect(logs.some((line) => line.includes(message))).toBe(true);
      expect(logs[logs.length - 1]).toMatch(/^Deployed version /);
    }
  });

  test("the mark follows no redirect, which would carry the token to another origin", async () => {
    const redirects: (RequestRedirect | undefined)[] = [];
    const { cli, logs } = fake(app(site), {
      push: innerUpload,
      mark: async (_token, init) => {
        redirects.push(init?.redirect);
        return new Response(null, { status: 307, headers: { Location: "https://other.example/" } });
      },
    });
    expect(await main(DEPLOY, cli)).toBe(0);
    expect(redirects).toEqual(["manual"]);
    expect(logs.some((line) => line.includes("did not answer as version"))).toBe(true);
  });

  test("a mark refused because a newer version is live says that deploys overlapped", async () => {
    const cwd = app(site);
    const { cli, logs } = fake(cwd, {
      push: innerUpload,
      mark: async () =>
        Response.json({ versionId: writtenSite(cwd).versionId, result: "superseded" }),
    });
    expect(await main(DEPLOY, cli)).toBe(0);
    expect(logs.some((line) => line.includes("a deploy overlapped this one"))).toBe(true);
  });

  test("a stored file that is gone before the version file is written fails the upload", async () => {
    const cwd = app(site);
    const { cli, logs } = fake(cwd);
    const convex = cli.convex;
    cli.convex = async (args) =>
      callName(args) === "urls"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ cloudUrl: CLOUD_URL, files: [["/index.html", null]] }),
            stderr: "",
          }
        : convex(args);
    expect(await main(["upload", "--dist", "dist", "--version-id", "v1"], cli)).toBe(1);
    expect(logs[logs.length - 1]).toBe(
      "The stored file of /index.html is gone, deleted by the age rule; run the deploy again.",
    );
    expect(existsSync(join(cwd, VERSION_FILE))).toBe(false);
  });

  test("a failed upload names the file", async () => {
    const { cli, logs } = fake(app(site));
    // The config, a string, stores; the files, bytes, do not.
    cli.fetch = async (_url, init) => {
      if (typeof init?.body === "string") return Response.json({ storageId: "storage-0" });
      throw new TypeError("fetch failed");
    };
    expect(await main(DEV, cli)).toBe(1);
    expect(logs[logs.length - 1]).toMatch(
      /^Storing .*dist.* failed: fetch failed\. Run the deploy again/,
    );
  });
});

describe("deploy without --build", () => {
  test("--dev uploads the folder as it is, then pushes", async () => {
    const { cli, events, builds } = fake(app(site));
    expect(await main(["deploy", "--dev", "--dist", "dist"], cli)).toBe(0);
    expect(builds).toEqual([]);
    expect(events[0]).toBe("probe");
    expect(events.slice(-3)).toEqual(["push: run", "site url", "mark"]);
  });

  test("production runs only the upload inside npx convex deploy --cmd", async () => {
    const { cli, pushes, events } = fake(app(site), { push: innerUpload });
    expect(await main(["deploy", "--dist", "dist"], cli)).toBe(0);
    expect(pushes[0][2]).toMatch(/^'.+' '.+' 'upload' '--dist' 'dist' '--version-id' '/);
    expect(events[0]).toBe("push: deploy");
    expect(events.slice(-4)).toEqual(["lib:finishVersion", "urls", "site url", "mark"]);
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
    // The upload runs inside the push; after it, the site URL query and the mark.
    expect(events[0]).toBe("push: deploy");
    expect(events.slice(-4)).toEqual(["lib:finishVersion", "urls", "site url", "mark"]);
    expect(callArgs("lib:createVersion")[0].versionId).toBe(writtenVersionId(cwd));
  });

  test("on a first install, uploads after the push, then pushes again", async () => {
    const cwd = app(site);
    let pushed = false;
    const pushedFiles: boolean[] = [];
    const { cli, calls, pushes } = fake(cwd, {
      installed: () => pushed,
      push: async (cli, args) => {
        if (args.includes("--cmd")) {
          const exitCode = await innerUpload(cli, args);
          expect(existsSync(join(cwd, ".convex-hosting", "first-install"))).toBe(true);
          pushedFiles.push(writtenSite(cwd).files !== null);
          pushed = true;
          return exitCode;
        }
        pushedFiles.push(writtenSite(cwd).files !== null);
        return 0;
      },
    });
    expect(await main(DEPLOY, cli)).toBe(0);

    expect(calls().slice(0, 3)).toEqual(["probe", "probe", "lib:generateUploadUrls"]);
    expect(calls().slice(-3)).toEqual(["lib:finishVersion", "urls", "site url"]);
    expect(pushes.map((args) => args[0])).toEqual(["deploy", "deploy"]);
    expect(pushes[1]).toEqual(["deploy"]);
    expect(pushedFiles).toEqual([false, true]);
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
    expect(events[events.length - 1]).toBe("urls");
    expect(logs[logs.length - 1]).toBe("npx convex deploy failed with exit code 1.");
  });

  test("--preview-name goes to npx convex deploy and to every run", async () => {
    const env = { CONVEX_DEPLOY_KEY: "preview:t:p|y" };
    const { cli, pushes, runs } = fake(app(site), { env, push: innerUpload });
    expect(await main([...DEPLOY, "--preview-name", "pr-7"], cli)).toBe(0);
    expect(pushes[0].slice(-2)).toEqual(["--preview-name", "pr-7"]);
    expect(pushes[0][2]).toContain("'--preview-name' 'pr-7'");
    expect(runs.every((args) => args.slice(-2).join(" ") === "--preview-name pr-7")).toBe(true);
  });

  test("appends the site URL to $GITHUB_OUTPUT when it is set", async () => {
    const cwd = app(site);
    const output = join(cwd, "github-output");
    writeFileSync(output, "earlier=1\n");
    const { cli, runs } = fake(cwd, {
      env: { GITHUB_OUTPUT: output, CONVEX_DEPLOY_KEY: "preview:t:p|y" },
      push: innerUpload,
    });
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

  test("names an instance without createVersion, such as convex-hosting 0.3.x, before any push", async () => {
    // What the Convex CLI prints, on a cloud and a local deployment alike.
    const notFound =
      `✖ Failed to run function "lib:createVersion":\nError: [Request ID: 1] Server Error\n` +
      "Could not find function for 'lib:createVersion' in 'staticHosting'. Did you forget to run `npx convex dev`?";
    const { cli, events, logs } = fake(app(site), { failing: { "lib:createVersion": notFound } });
    expect(await main([...DEV, "--component", "staticHosting"], cli)).toBe(1);
    expect(events).not.toContain("push: run");
    expect(logs[logs.length - 1]).toContain(
      'The component "staticHosting" has no lib:createVersion, so it is not convex-hosting 0.4 or later',
    );
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
      "urls",
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

    expect(versionFile(cwd).split("\n")[0]).toBe('export const versionId = "v1";');
    const written = writtenSite(cwd);
    expect(written).toMatchObject({ format: 1, versionId: "v1", markToken: expect.any(String) });
    const files = written.files;
    if (files === null) throw new Error("The version file has no files.");
    expect(files.cloudUrl).toBe(CLOUD_URL);
    expect(files.config).toMatchObject({
      compatibility_date: "2025-04-01",
      html_handling: "auto-trailing-slash",
      not_found_handling: "single-page-application",
    });
    expect(files.contentTypes).toEqual([
      "text/html; charset=utf-8",
      "text/javascript; charset=utf-8",
    ]);
    // Every path finds its stored file and its type; the two copies share one stored file.
    const found = await lookup(files, "/copy.html");
    expect(found).toEqual({
      contentHash: home.sha256.slice(0, 32),
      file: (await lookup(files, "/index.html"))?.file,
      contentType: "text/html; charset=utf-8",
    });
    expect(storageUrl(files.storage, found?.file ?? -1)).toBe(fileUrl(home.storageId));
    expect(await lookup(files, "/private/notes.txt")).toBeNull();
    expect(readFileSync(join(cwd, ".convex-hosting", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("reads the storage URLs a page at a time, and every path finds its stored file", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 2500 }, (_, i) => [`dist/assets/${i}.js`, `console.log(${i})`]),
    );
    const cwd = app(files);
    const { cli, calls } = fake(cwd);
    expect(await main(upload(), cli)).toBe(0);
    expect(calls().filter((name) => name === "urls")).toHaveLength(2);
    const written = writtenSite(cwd).files;
    if (written === null) throw new Error("The version file has no files.");
    for (const i of [0, 1999, 2000, 2499]) {
      expect(await lookup(written, `/assets/${i}.js`)).not.toBeNull();
    }
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

  test("does not walk a link to a folder, as Wrangler does not", async () => {
    const cwd = app({ "dist/assets/app.js": "console.log(1)" });
    symlinkSync(join(cwd, "dist", "assets"), join(cwd, "dist", "alias"));
    symlinkSync(join(cwd, "dist"), join(cwd, "dist", "loop"));
    const { cli, callArgs, logs } = fake(cwd);
    expect(await main(upload(), cli)).toBe(0);
    const [{ entries }] = callArgs("lib:recordFiles");
    expect(entries.map((entry: { path: string }) => entry.path)).toEqual(["/assets/app.js"]);
    for (const name of ["alias", "loop"]) {
      expect(logs).toContain(
        `Skipped ${join(cwd, "dist", name)}: a link to a folder, which Wrangler does not walk.`,
      );
    }
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
