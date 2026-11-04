// Prints the results of one or more runs as Markdown tables: one row per target and case, with the
// function calls per request that the deployment's logs show, the calls Convex bills (the logged
// functions plus the download of a stored body), the HTTP action's own time, and the latency and
// throughput that k6 saw.
//   node bench/report.ts <run> [<run> ...]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Result = {
  target: string;
  files: number;
  rate: number;
  duration: string;
  case: string;
  client: {
    requests: number;
    rate: number;
    checksPassed: number;
    dropped: number;
    latencyMs: { median: number; p95: number; p99: number };
  };
  server: {
    logCompleteness: number | null;
    functionsPerRequest: number | null;
    billedCallsPerRequest: number | null;
    byFunction: Record<string, number>;
    httpActionMs: { median: number | null; p95: number | null };
    innerFunctionMs: { median: number | null };
  };
};

const BENCH = new URL(".", import.meta.url).pathname;
const runs = process.argv.slice(2);
if (runs.length === 0) throw new Error("Usage: node bench/report.ts <run> [<run> ...]");

const fixed = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? "n/a" : value.toFixed(digits);

for (const run of runs) {
  const dir = join(BENCH, "results", run);
  const results: Result[] = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".k6.json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  const order = ["page", "asset", "rendered"];
  results.sort(
    (a, b) => order.indexOf(a.case) - order.indexOf(b.case) || a.target.localeCompare(b.target),
  );
  const first = results[0];
  console.log(`### ${run}: ${first.rate} requests/s for ${first.duration}, ${first.files} files\n`);
  console.log(
    "| Case | Target | Requests | Checks passed | Functions per request | Billed calls per request | HTTP action ms (median / p95) | Inner function ms (median) | Latency ms (median / p95 / p99) | Functions logged |",
  );
  console.log("| --- | --- | --: | --: | --: | --: | --: | --: | --: | --- |");
  for (const r of results) {
    const functions = Object.entries(r.server.byFunction)
      .map(([name, count]) => `${name}: ${count}`)
      .join("<br>");
    console.log(
      `| ${r.case} | ${r.target} | ${r.client.requests} | ${fixed(r.client.checksPassed * 100, 1)}% | ` +
        `${fixed(r.server.functionsPerRequest, 2)} | ${fixed(r.server.billedCallsPerRequest, 2)} | ` +
        `${fixed(r.server.httpActionMs.median, 1)} / ${fixed(r.server.httpActionMs.p95, 1)} | ` +
        `${fixed(r.server.innerFunctionMs.median, 1)} | ` +
        `${fixed(r.client.latencyMs.median)} / ${fixed(r.client.latencyMs.p95)} / ${fixed(r.client.latencyMs.p99)} | ` +
        `${functions} |`,
    );
  }
  console.log("");
}
