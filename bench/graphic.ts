// Draws the benchmark as one image for a post: what a million requests cost on each target, and,
// for the three Convex packages, the HTTP action's time. It reads the runs given, takes the mean of
// their per-round values, and writes bench/results/<out>.html, .json, and .png (Chrome, headless).
//   node bench/graphic.ts <out> <run> [<run> ...]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BENCH = new URL(".", import.meta.url).pathname;
const [out, ...runs] = process.argv.slice(2);
if (out === undefined || runs.length === 0) {
  throw new Error("Usage: node bench/graphic.ts <out> <run> [<run> ...]");
}

/** List prices beyond what each paid plan includes, checked 2026-11-11. */
const PRICE = {
  // Convex Professional: 25M function calls included, then $2 per million.
  convexCall: 2 / 1e6,
  // Cloudflare Workers Paid (Standard): 10M requests included, then $0.30 per million. Requests to
  // static assets are free and unlimited.
  workerRequest: 0.3 / 1e6,
};

const TARGETS = [
  { id: "workers", name: "Cloudflare Workers", note: "static assets" },
  { id: "convex-hosting-0.15.0", name: "convex-hosting 0.15.0", note: "" },
  { id: "convex-hosting-0.14.0", name: "convex-hosting 0.14.0", note: "" },
  { id: "static-hosting-0.2.1", name: "static-hosting 0.2.1", note: "" },
] as const;
const ACCENT = "convex-hosting-0.15.0";

type Result = {
  target: string;
  case: string;
  client: { requests: number; checksPassed: number; latencyMs: { median: number } };
  server: {
    billedCallsPerRequest: number | null;
    logCompleteness?: number | null;
    httpActionMs?: { median: number | null; mean?: number | null };
  };
};

const results: Result[] = runs.flatMap((run) => {
  const dir = join(BENCH, "results", run);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".k6.json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
});
for (const r of results) {
  if (r.client.checksPassed !== 1) throw new Error(`${r.target} ${r.case}: a check failed.`);
  if (r.server.logCompleteness != null && r.server.logCompleteness < 0.99) {
    throw new Error(`${r.target} ${r.case}: the logs hold ${r.server.logCompleteness} of requests.`);
  }
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
function measure(target: string, caseName: string) {
  const rounds = results.filter((r) => r.target === target && r.case === caseName);
  if (rounds.length === 0) return null;
  // 0.14.0 marks its version live at the first requests after a deploy, a few calls in a round.
  const calls = rounds.map((r) => Math.round((r.server.billedCallsPerRequest ?? Number.NaN) * 100) / 100);
  if (new Set(calls.map(Math.round)).size !== 1) {
    throw new Error(`${target} ${caseName}: calls differ: ${calls}`);
  }
  calls[0] = Math.round(calls[0]);
  const price = target === "workers" ? PRICE.workerRequest : PRICE.convexCall;
  const actionMs = rounds.map((r) => r.server.httpActionMs?.median ?? Number.NaN);
  return {
    rounds: rounds.length,
    requests: rounds.reduce((sum, r) => sum + r.client.requests, 0),
    billedPerRequest: calls[0],
    dollarsPerMillion: calls[0] * price * 1e6,
    httpActionMedianMs: target === "workers" ? null : mean(actionMs),
    httpActionMedianMsByRound: target === "workers" ? null : actionMs,
    clientMedianMs: mean(rounds.map((r) => r.client.latencyMs.median)),
  };
}

const CASES = [
  { id: "asset", title: "A file of the build", detail: "a script; index.html costs the same" },
  { id: "rendered", title: "A page the app renders", detail: "a path with no file, answered by code" },
];
const data = Object.fromEntries(
  CASES.map((c) => [c.id, Object.fromEntries(TARGETS.map((t) => [t.id, measure(t.id, c.id)]))]),
);
const page = Object.fromEntries(TARGETS.map((t) => [t.id, measure(t.id, "page")]));
writeFileSync(
  join(BENCH, "results", `${out}.json`),
  `${JSON.stringify({ runs, prices: PRICE, cases: { ...data, page } }, null, 2)}\n`,
);

/** The length in px of a bar at the top of its band's scale. */
const SCALE = 250;

const money = (dollars: number) => (dollars === 0 ? "$0" : `$${dollars.toFixed(2)}`);
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** One panel of horizontal bars, one row per target, on its own axis from zero. */
function panel(
  title: string,
  detail: string,
  rows: Array<{ id: string; name: string; value: number | null; label: string; empty?: string }>,
  max: number,
) {
  const body = rows
    .map((row) => {
      const width = row.value === null ? 0 : Math.round((Math.max(row.value, 0) / max) * SCALE);
      const bar =
        row.value === null
          ? `<span class="empty">${escape(row.empty ?? "")}</span>`
          : `<span class="bar${row.id === ACCENT ? " accent" : ""}${row.value === 0 ? " zero" : ""}" style="width:${width}px"></span><span class="value">${escape(row.label)}</span>`;
      return `<div class="row"><div class="name${row.id === ACCENT ? " strong" : ""}">${escape(row.name)}</div><div class="track">${bar}</div></div>`;
    })
    .join("");
  return `<section class="panel"><h2>${escape(title)}</h2><p class="detail">${escape(detail)}</p>${body}</section>`;
}

const costPanels = CASES.map((c) => {
  const rows = TARGETS.map((t) => {
    const m = data[c.id][t.id];
    if (m === null) return { id: t.id, name: t.name, value: null, label: "", empty: "renders no page" };
    const free = t.id === "workers" && m.dollarsPerMillion === 0;
    const unit = t.id === "workers" ? "request" : m.billedPerRequest === 1 ? "call" : "calls";
    const label = free ? "$0 · static assets are free" : `${money(m.dollarsPerMillion)} · ${m.billedPerRequest} ${unit}`;
    return { id: t.id, name: t.name, value: m.dollarsPerMillion, label };
  });
  return panel(c.title, c.detail, rows, 6);
}).join("");

const timePanels = CASES.map((c) => {
  const rows = TARGETS.filter((t) => t.id !== "workers").map((t) => {
    const m = data[c.id][t.id];
    if (m === null) return { id: t.id, name: t.name, value: null, label: "", empty: "renders no page" };
    return { id: t.id, name: t.name, value: m.httpActionMedianMs, label: `${m.httpActionMedianMs?.toFixed(1)} ms` };
  });
  return panel(c.title, "", rows, 70);
}).join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hosting benchmark</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root { --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781; --grid: #e1e0d9;
  --axis: #c3c2b7; --accent: #2a78d6; --other: #a19f97; }
* { box-sizing: border-box; margin: 0; }
body { width: 1600px; height: 900px; background: var(--surface); color: var(--ink);
  font-family: Inter, -apple-system, system-ui, sans-serif; padding: 48px 64px 0; position: relative; }
h1 { font-size: 50px; font-weight: 700; letter-spacing: -0.02em; }
.lede { font-size: 24px; color: var(--ink-2); margin-top: 8px; }
.band { display: flex; align-items: baseline; gap: 16px; margin-top: 40px; padding-bottom: 8px; border-bottom: 1px solid var(--grid); }
.band h3 { font-size: 17px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-2); }
.band span { font-size: 17px; color: var(--muted); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; margin-top: 16px; }
.panel h2 { font-size: 23px; font-weight: 600; }
.detail { font-size: 17px; color: var(--muted); margin-top: 2px; }
.row { display: grid; grid-template-columns: 252px 1fr; align-items: center; height: 47px; }
.panel h2 + .row, .panel .detail + .row { margin-top: 8px; }
.name { font-size: 21px; color: var(--ink-2); }
.name.strong { color: var(--ink); font-weight: 600; }
.track { display: flex; align-items: center; height: 24px; border-left: 1px solid var(--axis); }
.bar { flex: none; height: 24px; background: var(--other); border-radius: 0 4px 4px 0; margin-right: 12px; }
.bar.accent { background: var(--accent); }
.bar.zero { margin-right: 0; }
.value { font-size: 21px; color: var(--ink); white-space: nowrap; font-feature-settings: "tnum"; padding-left: 0; }
.bar.zero + .value { padding-left: 12px; }
.empty { font-size: 20px; color: var(--muted); font-style: italic; padding-left: 12px; }
footer { position: absolute; left: 64px; right: 64px; bottom: 30px; font-size: 15px; color: var(--muted); line-height: 1.5; }
</style></head>
<body>
<h1>What one million requests cost</h1>
<p class="lede">The same 400-file site on each, with every request reaching the server, as in a flood.</p>
<div class="band"><h3>Dollars per million requests</h3><span>at list price, beyond each plan's included usage</span></div>
<div class="grid">${costPanels}</div>
<div class="band"><h3>Time in the HTTP action</h3><span>median, from each deployment's logs; Convex only</span></div>
<div class="grid">${timePanels}</div>
<footer>${escape(FOOTNOTE())}</footer>
</body></html>
`;

function FOOTNOTE() {
  return (
    "Measured 2026-11-11: 25 requests/s for 60 s per case, two rounds, every response checked, calls counted from the platforms' logs. " +
    "Convex Professional: $2 per million function calls beyond 25 million; a file's download from storage counts as a call. " +
    "Workers Paid: $0.30 per million requests beyond 10 million. Not included: Convex action compute and egress, Workers CPU time. " +
    "Convex deployments in US East; Workers answers from the nearest Cloudflare location. Method: github.com/samebase/convex-hosting/tree/nicu-hosting-bench/bench"
  );
}

const htmlFile = join(BENCH, "results", `${out}.html`);
writeFileSync(htmlFile, html);
const png = join(BENCH, "results", `${out}.png`);
execFileSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new",
  "--hide-scrollbars",
  "--force-device-scale-factor=2",
  "--window-size=1600,900",
  "--virtual-time-budget=4000",
  `--screenshot=${png}`,
  `file://${htmlFile}`,
]);
console.log(png);
