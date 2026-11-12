// Benchmarks one hosting target on its own Convex cloud project: it writes the target's app to
// bench/.work/<target>/ with the package pinned to one exact version, deploys a synthetic site to
// the project's development deployment, then runs each case with k6 at a fixed arrival rate while
// it streams the deployment's function logs. One JSON file per case goes to bench/results/<run>/.
//
//   node bench/run.ts <target> --run <name> [--files 400] [--rate 25] [--duration 60s]
//     [--cases page,asset,rendered] [--no-deploy]
//
// Targets: convex-hosting-0.14.0 and convex-hosting-0.15.0 (npm), convex-hosting-branch (this
// checkout, packed), static-hosting-0.2.1 (npm, the component-owned mode its README calls the
// fastest), and workers: the same site as Cloudflare Workers static assets, with a Worker script
// that renders the same page, on workers.dev, whose server side comes from `wrangler tail`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeSite } from "./site.ts";

const BENCH = dirname(new URL(import.meta.url).pathname);
const REPO = resolve(BENCH, "..");
const TEAM = process.env.BENCH_TEAM ?? "nicu";
const CONVEX = "1.46.0";

/** A page that `worker` renders, for the case that no file answers. */
const WORKER = `{
  fetch: async () =>
    new Response("<!doctype html><title>Rendered</title><h1>Rendered</h1>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
}`;

const hostingConfig = `import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

const app = defineApp();
app.use(hosting);
export default app;
`;

/** The app's `convex/http.ts` with one object, as `routeAll` takes it from 0.15.0 on. */
const hostingHttpAssets = `import { httpRouter } from "convex/server";
import { routeAll } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { assets } from "../.convex-hosting/version.js";

const http = httpRouter();
// A worker that renders one small page, so the rendered case measures hosting, not a framework.
routeAll({ http, component: components.hosting, assets, worker: ${WORKER} });
export default http;
`;

/** The same for 0.14.0, whose `routeAll` takes its arguments in order, with the version's id. */
const hostingHttpVersionId = `import { httpRouter } from "convex/server";
import { routeAll } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();
// A worker that renders one small page, so the rendered case measures hosting, not a framework.
routeAll(http, components.hosting, versionId, ${WORKER});
export default http;
`;

type Target = {
  /** Where it runs: a Convex project's development deployment, or Cloudflare Workers. */
  platform: "convex" | "workers";
  project: string;
  dependencies: Record<string, string>;
  files: Record<string, string>;
  cases: CaseName[];
  deploy: (cwd: string) => void;
};

function packBranch(): string {
  const dir = join(BENCH, ".work", "pack");
  mkdirSync(dir, { recursive: true });
  const output = execFileSync("pnpm", ["pack", "--pack-destination", dir], {
    cwd: join(REPO, "packages", "convex-hosting"),
    encoding: "utf8",
  });
  const tarball = output.trim().split("\n").pop() ?? "";
  if (!tarball.endsWith(".tgz")) throw new Error(`pnpm pack printed no tarball:\n${output}`);
  return tarball;
}

const WRANGLER = "4.160.0";

const targets: Record<string, () => Target> = {
  "convex-hosting-0.15.0": () => ({
    platform: "convex",
    project: "convex-hosting-bench",
    dependencies: { "@samebase/convex-hosting": "0.15.0" },
    files: { "convex/convex.config.ts": hostingConfig, "convex/http.ts": hostingHttpAssets },
    cases: ["page", "asset", "rendered"],
    deploy: (cwd) => sh(cwd, "npx", ["convex-hosting", "deploy", "--dev", "--dist", "site"]),
  }),
  workers: () => ({
    platform: "workers",
    project: "convex-hosting-bench-workers",
    dependencies: { wrangler: WRANGLER },
    files: {
      "wrangler.jsonc": `${JSON.stringify(
        {
          name: "convex-hosting-bench-workers",
          main: "worker.js",
          compatibility_date: "2026-11-01",
          workers_dev: true,
          // Requests that match a file never run the Worker; the rest run it.
          assets: { directory: "./site" },
          observability: { enabled: false },
        },
        null,
        2,
      )}\n`,
      // The same page as the Convex targets' worker.
      "worker.js": `export default ${WORKER};\n`,
    },
    cases: ["page", "asset", "rendered"],
    deploy: (cwd) => {
      const output = execFileSync("npx", ["wrangler", "deploy"], { cwd, encoding: "utf8" });
      process.stderr.write(output);
      const url = /https:\/\/\S+\.workers\.dev/.exec(output)?.[0];
      if (url === undefined) throw new Error("wrangler deploy printed no workers.dev URL.");
      writeFileSync(join(cwd, "site-url.txt"), `${url}\n`);
    },
  }),
  "convex-hosting-0.14.0": () => ({
    platform: "convex",
    project: "convex-hosting-bench-014",
    dependencies: { "@samebase/convex-hosting": "0.14.0" },
    files: { "convex/convex.config.ts": hostingConfig, "convex/http.ts": hostingHttpVersionId },
    cases: ["page", "asset", "rendered"],
    deploy: (cwd) => sh(cwd, "npx", ["convex-hosting", "deploy", "--dev", "--dist", "site"]),
  }),
  "convex-hosting-branch": () => ({
    platform: "convex",
    project: "convex-hosting-bench",
    dependencies: { "@samebase/convex-hosting": `file:${packBranch()}` },
    files: { "convex/convex.config.ts": hostingConfig, "convex/http.ts": hostingHttpAssets },
    cases: ["page", "asset", "rendered"],
    deploy: (cwd) => sh(cwd, "npx", ["convex-hosting", "deploy", "--dev", "--dist", "site"]),
  }),
  "static-hosting-0.2.1": () => ({
    platform: "convex",
    project: "convex-hosting-bench-static",
    dependencies: { "@convex-dev/static-hosting": "0.2.1" },
    files: {
      "convex/convex.config.ts": `import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// The component owns "/", the mode static-hosting's README calls the fastest.
const app = defineApp({ httpPrefix: "/api" });
app.use(staticHosting, { httpPrefix: "/" });
export default app;
`,
    },
    // It renders no page: a path without a file answers its index.html or 404.
    cases: ["page", "asset"],
    deploy: (cwd) => {
      sh(cwd, "npx", ["convex", "dev", "--once"]);
      sh(cwd, "npx", ["@convex-dev/static-hosting", "upload", "--dist", "site", "--no-spa"]);
    },
  }),
};

type CaseName = "page" | "asset" | "rendered";
type Case = {
  path: (paths: { asset: string }) => string;
  marker: string;
  fetchMode: string;
  /** Whether the answer's body is a stored file, whose download Convex counts as a call. */
  download: boolean;
};
const CASES: Record<CaseName, Case> = {
  page: { path: () => "/", marker: "Benchmark site", fetchMode: "navigate", download: true },
  asset: {
    path: (paths) => paths.asset,
    marker: "export const chunk",
    fetchMode: "no-cors",
    download: true,
  },
  rendered: { path: () => "/rendered", marker: "Rendered", fetchMode: "navigate", download: false },
};

function sh(cwd: string, command: string, args: string[]) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** The deployment and the site URL that the benchmark loads. */
function siteOf(cwd: string, target: Target) {
  if (target.platform === "workers") {
    const site = readFileSync(join(cwd, "site-url.txt"), "utf8").trim();
    return { deployment: target.project, site };
  }
  return convexEnv(cwd);
}

function convexEnv(cwd: string) {
  const env = readFileSync(join(cwd, ".env.local"), "utf8");
  const deployment = /^CONVEX_DEPLOYMENT=(?:dev:)?([a-z0-9-]+)/m.exec(env)?.[1];
  const site = /^CONVEX_SITE_URL=(\S+)/m.exec(env)?.[1];
  if (deployment === undefined) throw new Error(`${cwd}/.env.local has no CONVEX_DEPLOYMENT.`);
  return { deployment, site: site ?? `https://${deployment}.convex.site` };
}

/** Writes the app and binds it to the target's project, creating the project on the first run. */
function setUp(name: string, target: Target, files: number) {
  const cwd = join(BENCH, ".work", name);
  mkdirSync(join(cwd, "convex"), { recursive: true });
  const pkg = {
    name: `bench-${name}`,
    private: true,
    type: "module",
    dependencies: { convex: CONVEX, ...target.dependencies },
  };
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [path, body] of Object.entries(target.files)) writeFileSync(join(cwd, path), body);
  sh(cwd, "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]);
  if (target.platform === "convex" && !existsSync(join(cwd, ".env.local"))) {
    const configure = (kind: string) =>
      execFileSync(
        "npx",
        [
          "convex",
          "dev",
          "--once",
          "--configure",
          kind,
          "--team",
          TEAM,
          "--project",
          target.project,
          "--dev-deployment",
          "cloud",
        ],
        { cwd, stdio: "inherit" },
      );
    // The first push fails while `.convex-hosting/version.js` does not exist yet; the project and
    // `.env.local` are configured by then, which is what this step is for.
    try {
      configure("existing");
    } catch {
      if (!existsSync(join(cwd, ".env.local"))) {
        try {
          configure("new");
        } catch {
          if (!existsSync(join(cwd, ".env.local")))
            throw new Error(`Configuring ${target.project} failed.`);
        }
      }
    }
  }
  const paths = writeSite(files, cwd);
  return { cwd, paths };
}

const median = (values: number[]) => quantile(values, 0.5);
function quantile(values: number[], q: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

type LogEntry = {
  kind: string;
  udfType: string;
  identifier: string;
  componentPath: string | null;
  requestId: string;
  executionId: string;
  timestamp: number;
  executionTime: number;
  success: { status?: string } | null;
};

/** Runs one case with k6 while the deployment's logs stream to a file, and measures both. */
async function runCase(
  cwd: string,
  site: string,
  caseName: CaseName,
  paths: { asset: string },
  options: { rate: number; duration: string; out: string; target: Target },
) {
  const spec = CASES[caseName];
  const workers = options.target.platform === "workers";
  const logFile = `${options.out}.logs.jsonl`;
  // Convex's log stream of the deployment, or Cloudflare's tail of the Worker, which reports each
  // run of the Worker script and nothing for a request that a static asset answers.
  const logs = workers
    ? spawn("npx", ["wrangler", "tail", options.target.project, "--format", "json"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      })
    : spawn("npx", ["convex", "logs", "--success", "--jsonl"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
  const chunks: Buffer[] = [];
  logs.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise((done) => setTimeout(done, 8000));
  const start = Date.now() / 1000;
  const summaryFile = `${options.out}.k6.json`;
  execFileSync(
    "k6",
    [
      "run",
      "--quiet",
      "-e",
      `BASE=${site}`,
      "-e",
      `TARGET_PATH=${spec.path(paths)}`,
      "-e",
      "STATUS=200",
      "-e",
      `MARKER=${spec.marker}`,
      "-e",
      `FETCH_MODE=${spec.fetchMode}`,
      "-e",
      `RATE=${options.rate}`,
      "-e",
      `DURATION=${options.duration}`,
      "-e",
      `OUT=${summaryFile}`,
      join(BENCH, "load.js"),
    ],
    { stdio: "inherit" },
  );
  const end = Date.now() / 1000;
  // Logs arrive a few seconds after the executions.
  await new Promise((done) => setTimeout(done, 15000));
  logs.kill();
  writeFileSync(logFile, Buffer.concat(chunks));
  if (workers) {
    return {
      case: caseName,
      path: spec.path(paths),
      client: clientOf(`${options.out}.k6.json`),
      server: workerRuns(Buffer.concat(chunks).toString("utf8"), start, end, summaryFile),
    };
  }

  const entries: LogEntry[] = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry?.kind === "Completion" ? [entry] : [];
      } catch {
        return [];
      }
    })
    .filter((entry) => entry.timestamp >= start - 1 && entry.timestamp <= end + 10);
  const unique = [...new Map(entries.map((entry) => [entry.executionId, entry])).values()];
  const http = unique.filter((entry) => entry.udfType === "HttpAction");
  const requestIds = new Set(http.map((entry) => entry.requestId));
  const inner = unique.filter(
    (entry) => entry.udfType !== "HttpAction" && requestIds.has(entry.requestId),
  );
  const byFunction: Record<string, number> = {};
  for (const entry of [...http, ...inner]) {
    const key = `${entry.udfType} ${entry.componentPath ? `${entry.componentPath}/` : ""}${entry.identifier}`;
    byFunction[key] = (byFunction[key] ?? 0) + 1;
  }
  const k6 = JSON.parse(readFileSync(summaryFile, "utf8"));
  const metric = (name: string) => k6.metrics[name]?.values ?? {};
  const requests = metric("http_reqs").count ?? 0;
  const checks = metric("checks");
  const executionsPerRequest =
    http.length === 0 ? null : (http.length + inner.length) / http.length;
  const passRate = checks.rate ?? 0;
  return {
    case: caseName,
    path: spec.path(paths),
    client: {
      requests,
      rate: metric("http_reqs").rate,
      checksPassed: passRate,
      failed: metric("http_req_failed").rate,
      dropped: metric("dropped_iterations").count ?? 0,
      latencyMs: {
        median: metric("http_req_duration").med,
        p90: metric("http_req_duration")["p(90)"],
        p95: metric("http_req_duration")["p(95)"],
        p99: metric("http_req_duration")["p(99)"],
        max: metric("http_req_duration").max,
      },
    },
    server: {
      httpActionsLogged: http.length,
      logCompleteness: requests === 0 ? null : http.length / requests,
      functionsPerRequest: executionsPerRequest,
      downloadsPerRequest: spec.download ? 1 : 0,
      billedCallsPerRequest:
        executionsPerRequest === null ? null : executionsPerRequest + (spec.download ? 1 : 0),
      byFunction,
      httpActionMs: {
        median: median(http.map((entry) => entry.executionTime * 1000)),
        // The mean, which action compute is billed on.
        mean:
          http.length === 0
            ? null
            : http.reduce((sum, entry) => sum + entry.executionTime * 1000, 0) / http.length,
        p95: quantile(
          http.map((entry) => entry.executionTime * 1000),
          0.95,
        ),
      },
      innerFunctionMs: {
        median: median(inner.map((entry) => entry.executionTime * 1000)),
        p95: quantile(
          inner.map((entry) => entry.executionTime * 1000),
          0.95,
        ),
      },
    },
  };
}

/** What k6 saw. */
function clientOf(summaryFile: string) {
  const k6 = JSON.parse(readFileSync(summaryFile, "utf8"));
  const metric = (name: string) => k6.metrics[name]?.values ?? {};
  return {
    requests: metric("http_reqs").count ?? 0,
    rate: metric("http_reqs").rate,
    checksPassed: metric("checks").rate ?? 0,
    failed: metric("http_req_failed").rate,
    dropped: metric("dropped_iterations").count ?? 0,
    latencyMs: {
      median: metric("http_req_duration").med,
      p90: metric("http_req_duration")["p(90)"],
      p95: metric("http_req_duration")["p(95)"],
      p99: metric("http_req_duration")["p(99)"],
      max: metric("http_req_duration").max,
    },
  };
}

/** The JSON objects of `wrangler tail --format json`, which prints each event over many lines. */
function tailEvents(text: string): Array<Record<string, any>> {
  const events = [];
  let depth = 0;
  let begin = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") {
      if (depth++ === 0) begin = i;
    } else if (c === "}" && --depth === 0) {
      try {
        events.push(JSON.parse(text.slice(begin, i + 1)));
      } catch {}
    }
  }
  return events;
}

/**
 * The runs of the Worker script during the load. Cloudflare bills a run as a request and does not
 * bill a request that a static asset answers. `wrangler tail` samples: it delivered 17 of 51 runs at
 * 5 requests/s. A request runs the script once or not at all, so a case with any run costs one
 * billed request per request, and a case with none costs nothing.
 */
function workerRuns(text: string, start: number, end: number, summaryFile: string) {
  const requests = clientOf(summaryFile).requests;
  const runs = tailEvents(text).filter(
    (event) =>
      String(event.event?.request?.url ?? "").includes("?bench=") &&
      event.eventTimestamp / 1000 >= start - 1 &&
      event.eventTimestamp / 1000 <= end + 10,
  );
  const wall = runs.map((event) => Number(event.wallTime));
  const cpu = runs.map((event) => Number(event.cpuTime));
  const mean = (values: number[]) =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  const perRequest = requests === 0 ? null : runs.length > 0 ? 1 : 0;
  return {
    sampledWorkerRuns: runs.length,
    outcomes: Object.fromEntries(
      [...new Set(runs.map((event) => String(event.outcome)))].map((outcome) => [
        outcome,
        runs.filter((event) => event.outcome === outcome).length,
      ]),
    ),
    functionsPerRequest: perRequest,
    downloadsPerRequest: 0,
    billedCallsPerRequest: perRequest,
    workerWallMs: { median: median(wall), mean: mean(wall), p95: quantile(wall, 0.95) },
    workerCpuMs: { median: median(cpu), mean: mean(cpu), p95: quantile(cpu, 0.95) },
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      run: { type: "string" },
      files: { type: "string", default: "400" },
      rate: { type: "string", default: "25" },
      duration: { type: "string", default: "60s" },
      cases: { type: "string" },
      "no-deploy": { type: "boolean", default: false },
    },
  });
  const [name] = positionals;
  const make = targets[name ?? ""];
  if (make === undefined || values.run === undefined) {
    throw new Error(
      `Usage: node bench/run.ts <${Object.keys(targets).join(" | ")}> --run <name> [options]`,
    );
  }
  const target = make();
  const files = Number(values.files);
  const { cwd, paths } = setUp(name, target, files);
  let deploySeconds: number | null = null;
  if (!values["no-deploy"]) {
    const started = Date.now();
    target.deploy(cwd);
    deploySeconds = (Date.now() - started) / 1000;
    console.error(`Deployed ${files} files in ${deploySeconds.toFixed(0)} s.`);
  }
  const { deployment, site } = siteOf(cwd, target);
  const cases = (values.cases?.split(",") ?? target.cases) as CaseName[];
  const outDir = join(BENCH, "results", values.run);
  mkdirSync(outDir, { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  for (const caseName of cases) {
    const out = join(outDir, `${name}-${files}-${caseName}`);
    console.error(
      `${name}, ${files} files, ${caseName}: ${values.rate}/s for ${values.duration} on ${site}`,
    );
    const result = await runCase(cwd, site, caseName, paths, {
      rate: Number(values.rate),
      duration: values.duration,
      out,
      target,
    });
    const record = {
      target: name,
      // The packed branch build lives in bench/.work/pack, whatever the checkout's path.
      dependencies: Object.fromEntries(
        Object.entries(target.dependencies).map(([name, spec]) => [
          name,
          spec.replace(`file:${BENCH}/`, "file:bench/"),
        ]),
      ),
      convex: CONVEX,
      commit,
      deployment,
      files,
      deploySeconds,
      rate: Number(values.rate),
      duration: values.duration,
      date: new Date().toISOString(),
      ...result,
    };
    writeFileSync(`${out}.json`, `${JSON.stringify(record, null, 2)}\n`);
    console.error(
      JSON.stringify({ case: caseName, client: result.client, server: result.server }, null, 2),
    );
  }
}

await main();
