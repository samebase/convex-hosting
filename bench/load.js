// k6 load script for one case. Every request carries a unique query string, so no cache in front
// of the deployment answers it: each one reaches the HTTP action, as a flood would. Every response
// is checked for its status and for a marker in its body.
//
//   k6 run -e BASE=https://<deployment>.convex.site -e TARGET_PATH=/ -e STATUS=200 \
//     -e MARKER="Benchmark site" -e RATE=25 -e DURATION=60s -e OUT=summary.json load.js
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";

const rate = Number(__ENV.RATE ?? 25);
export const options = {
  scenarios: {
    load: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration: __ENV.DURATION ?? "60s",
      preAllocatedVUs: Math.max(20, rate * 2),
      maxVUs: Math.max(200, rate * 10),
    },
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const status = Number(__ENV.STATUS ?? 200);
const marker = __ENV.MARKER ?? "";

export default function () {
  const url = `${__ENV.BASE}${__ENV.TARGET_PATH}?bench=${exec.scenario.iterationInTest}-${Date.now()}`;
  const response = http.get(url, {
    headers: { "Sec-Fetch-Mode": __ENV.FETCH_MODE ?? "no-cors" },
    redirects: 0,
  });
  check(response, {
    status: (r) => r.status === status,
    body: (r) => typeof r.body === "string" && r.body.includes(marker),
  });
}

export function handleSummary(data) {
  return { [__ENV.OUT ?? "summary.json"]: JSON.stringify(data, null, 2) };
}
