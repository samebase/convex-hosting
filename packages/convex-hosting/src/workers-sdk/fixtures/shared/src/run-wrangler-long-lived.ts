// Our implementation of the helper that Cloudflare's fixtures import to start `wrangler dev`: the
// same name, at the path they import it from, so the copied tests run unchanged. It serves the
// fixture through the whole path an app takes here: an anonymous local Convex deployment, the
// real `convex-hosting deploy --dev` for the fixture's assets with the options of its
// `wrangler.jsonc`, and the address the deployment serves the site at.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

/** packages/convex-hosting, whose built CLI and component the fixture project uses. */
const PACKAGE = resolve(import.meta.dirname, "../../../../..");

const HOST = "127.0.0.1";

/** The fields of a fixture's `wrangler.jsonc` that decide how its assets are served. */
type WranglerConfig = {
  main?: string;
  assets: {
    directory: string;
    html_handling?: string;
    not_found_handling?: string;
  };
};

/** Reads `wrangler.jsonc`: JSON with comments and trailing commas. */
function readWranglerConfig(folder: string): WranglerConfig {
  const text = readFileSync(join(folder, "wrangler.jsonc"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text) as WranglerConfig;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

/** Writes the Convex app that serves the fixture: the README's setup, nothing more. */
function writeProject(project: string, name: string) {
  mkdirSync(join(project, "convex"), { recursive: true });
  mkdirSync(join(project, "node_modules/@samebase"), { recursive: true });
  const convexVersion = (
    JSON.parse(readFileSync(join(PACKAGE, "node_modules/convex/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      {
        name: `fixture-${name}`,
        private: true,
        type: "module",
        dependencies: { "@samebase/convex-hosting": "*", convex: convexVersion },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(project, "convex/convex.config.ts"),
    `import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

const app = defineApp();
app.use(hosting);

export default app;
`,
  );
  writeFileSync(
    join(project, "convex/http.ts"),
    `import { httpRouter } from "convex/server";
import { serveSite } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: httpAction((ctx, request) => serveSite(ctx, components.hosting, request, versionId)),
});

export default http;
`,
  );
  writeFileSync(
    join(project, "convex/tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          moduleResolution: "Bundler",
          skipLibCheck: true,
          target: "ESNext",
          lib: ["ES2021", "dom"],
          module: "ESNext",
          isolatedModules: true,
          noEmit: true,
        },
        include: ["./**/*"],
        exclude: ["./_generated"],
      },
      null,
      2,
    ),
  );
  for (const [link, target] of [
    ["node_modules/convex", join(PACKAGE, "node_modules/convex")],
    ["node_modules/@samebase/convex-hosting", PACKAGE],
  ]) {
    const path = join(project, link);
    rmSync(path, { recursive: true, force: true });
    symlinkSync(target, path, "dir");
  }
}

async function waitForHttp(url: string, getOutput: () => string, exited: () => boolean) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (exited()) throw new Error(`npx convex dev exited:\n${getOutput()}`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`No HTTP answer at ${url}:\n${getOutput()}`);
}

/**
 * Starts the fixture at `folder`: an anonymous local Convex deployment, kept running by
 * `npx convex dev` as the README's local-deployment loop requires, with the fixture's assets
 * deployed by `convex-hosting deploy --dev`. Returns the site's address and a `stop` that ends
 * the deployment. `args` are Wrangler's and are ignored.
 */
export async function runWranglerDev(
  folder: string,
  _args: string[],
): Promise<{
  ip: string;
  port: number;
  stop: () => Promise<unknown>;
  getOutput: () => string;
  clearOutput: () => void;
}> {
  const config = readWranglerConfig(folder);
  if (config.main !== undefined) {
    throw new Error(`${basename(folder)} has a Worker script; only files-only fixtures run here.`);
  }
  const name = basename(folder);
  const project = join(tmpdir(), "convex-hosting-fixtures", name);
  writeProject(project, name);
  const convexBin = join(
    createRequire(join(project, "package.json")).resolve("convex/package.json"),
    "../bin/main.js",
  );
  const [cloudPort, sitePort] = await Promise.all([freePort(), freePort()]);

  let output = "";
  let exited = false;
  const dev = spawn(
    process.execPath,
    [
      convexBin,
      "dev",
      "--local-cloud-port",
      String(cloudPort),
      "--local-site-port",
      String(sitePort),
    ],
    {
      cwd: project,
      env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  dev.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  dev.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const devExited = new Promise<void>((r) => dev.on("exit", () => ((exited = true), r())));
  const stop = async () => {
    dev.kill("SIGINT");
    await devExited;
  };

  try {
    await waitForHttp(
      `http://${HOST}:${sitePort}/`,
      () => output,
      () => exited,
    );
    const deployArgs = [
      join(PACKAGE, "dist/cli/index.js"),
      "deploy",
      "--dev",
      "--build",
      "true",
      "--dist",
      resolve(folder, config.assets.directory),
    ];
    if (config.assets.html_handling)
      deployArgs.push("--html-handling", config.assets.html_handling);
    if (config.assets.not_found_handling) {
      deployArgs.push("--not-found-handling", config.assets.not_found_handling);
    }
    const { stdout, stderr } = await promisify(execFile)(process.execPath, deployArgs, {
      cwd: project,
      env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
      maxBuffer: 16 * 1024 * 1024,
    });
    output += stdout + stderr;
    const url = /Deployed version \S+ to (\S+)\.\s*$/m.exec(stdout + stderr)?.[1];
    if (url === undefined) throw new Error(`No site URL in the deploy output:\n${stdout}${stderr}`);
    if (new URL(url).port !== String(sitePort)) {
      throw new Error(`The site URL ${url} is not on the site port ${sitePort}.`);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    ip: HOST,
    port: sitePort,
    stop,
    getOutput: () => output,
    clearOutput: () => (output = ""),
  };
}
