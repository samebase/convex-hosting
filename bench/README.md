# Benchmark

What one request to a hosted site costs, for these targets:

- **convex-hosting 0.14.0**, from npm: the HTTP action asks the component's `route` query which file
  answers.
- **convex-hosting 0.15.0**, this repository's package, packed (target `convex-hosting-branch`): the
  HTTP action answers from the site's files, which the deploy writes into the pushed code.
- **convex-hosting 0.15.0**, the same as published to npm (the 2026-11-11 runs install it from npm,
  target `convex-hosting-0.15.0`).
- **Cloudflare Workers**, target `workers`: the same site as a Worker's static assets, with a Worker
  script that renders the same page, on workers.dev. Its server side comes from `wrangler tail`,
  which samples; a request runs the script once or not at all, so a case with any run costs one
  billed request per request.
- **@convex-dev/static-hosting 0.2.1**, from npm, mounted at `/`
  (`app.use(staticHosting, { httpPrefix: "/" })`), the mode its README calls the fastest: the
  component's own HTTP action runs its `resolveAsset` query and reads the file from storage.

Convex bills function calls: every query, mutation, action, and HTTP action, and every download of a
stored file ([usage limits](https://docs.convex.dev/production/usage-limits)). A flood against a
site spends them, so calls per request decide what a flood costs, and when the team's spending limit
turns every project off.

## Method

- **One Convex cloud project per target**, each with its own development deployment, created by
  `run.ts`: `convex-hosting-bench-014`, `convex-hosting-bench` (this repository's package), and
  `convex-hosting-bench-static`. Convex 1.46.0 in each app.
- **The same synthetic site** for all three, from `site.ts`: `index.html`, `404.html`, and 400
  scripts of about 2 KB with Vite-style hashed names, every file with its own bytes.
- **Cases.** `page`: `GET /` with `Sec-Fetch-Mode: navigate`, answered by `index.html`. `asset`:
  `GET` of a hashed script. `rendered`: `GET /rendered` with `Sec-Fetch-Mode: navigate`, a path with
  no file, answered by the app's code; the convex-hosting apps pass a worker that returns one small
  page, so the case measures hosting and not a framework. static-hosting renders no page, so it has
  no `rendered` case.
- **No cache answers.** Each request carries a unique query string, so the Cloudflare front of
  `*.convex.site` passes every request to the HTTP action, as it does in a flood. A real site that
  sends a long `Cache-Control` for its hashed files (the `/assets/*` rule in
  [serving](../docs/serving.md)) has a repeat request answered by that front, with no function run.
- **Every response is checked**: the status and a marker in its body (`load.js`). A fast error is
  not a result.
- **Open load**: k6's `constant-arrival-rate` executor sends a fixed number of requests per second
  whatever the latency, and reports the requests it could not send (`dropped`).
- **Server side** from the deployment's own log stream (`npx convex logs --success --jsonl`),
  started before the load and drained after it: every function execution of every request, grouped
  by request id. `logCompleteness` is the HTTP actions logged over the requests k6 sent; every run
  below logged all of them. A stored file's download does not appear in the logs, so
  `billedCallsPerRequest` adds one for each answer whose body is a stored file. Convex counts a
  query served from its cache as a call too.
- **The client** is one laptop in Chișinău, so client latency includes the round trip to the
  deployments; the server-side numbers do not depend on it.

Run it:

```sh
brew install k6   # or https://grafana.com/docs/k6/latest/set-up/install-k6/
node bench/run.ts convex-hosting-0.14.0 --run <name> --files 400 --rate 25 --duration 60s
node bench/run.ts convex-hosting-branch --run <name> --files 400 --rate 25 --duration 60s
node bench/run.ts static-hosting-0.2.1 --run <name> --files 400 --rate 25 --duration 60s
node bench/report.ts <name>
```

The first run of a target creates its project in the team in `BENCH_TEAM` (default `nicu`) and
deploys; `--no-deploy` reuses the deployed site. `bench/.work/` holds the apps and the packed build
of this repository's package; `bench/results/<run>/` holds one JSON file per case and k6's own
summary next to it. This repository keeps the 2026-11-11 summary only; the per-case results of every
run below are on the branch
[`nicu-hosting-bench`](https://github.com/samebase/convex-hosting/tree/nicu-hosting-bench/bench/results).

## Results, 2026-11-11

The published packages and Cloudflare Workers, the same method: 400 files, two rounds at 25
requests/s for 60 s per case, targets taking turns. Every response passed its checks; the Convex
logs held every request. All three Convex deployments are in `aws-us-east-1`, class `s256`.

| Case     | Workers: billed / $ per million | 0.15.0: billed / $ per million | 0.14.0: billed / $ per million | static-hosting 0.2.1: billed / $ per million |
| -------- | ------------------------------: | -----------------------------: | -----------------------------: | -------------------------------------------: |
| file     |                          0 / $0 |                      2 / $4.00 |                      3 / $6.00 |                                    3 / $6.00 |
| rendered |                       1 / $0.30 |                      1 / $2.00 |                      2 / $4.00 |                                cannot render |

Prices beyond each paid plan's included usage: Convex Professional, $2 per million function calls;
Workers Paid, $0.30 per million requests, static asset requests free. Not counted: Convex action
compute and egress, Workers CPU time. The Convex counts are measured, from logs that held every
request. The Workers counts follow from its routing and Cloudflare's pricing: `wrangler tail`
samples, so it showed that the script ran for the rendered page and never for a file, not how often.

HTTP action median, the mean of the two rounds: a file 46.3 ms on 0.15.0, 66.3 ms on 0.14.0, 34.0 ms
on static-hosting; a rendered page 4.2 ms on 0.15.0, 26.5 ms on 0.14.0. Client latency from
Chișinău, where Cloudflare answered from Chișinău itself and Convex from US East: about 16 ms for
Workers and 140 to 380 ms for the Convex targets, which measures the distance more than the hosting.

`node bench/graphic.ts 2026-11-11-comparison 2026-11-11-round-1 2026-11-11-round-2` draws
`results/2026-11-11-comparison.png`.

## Results, 2026-11-04

400 files. Two rounds at 25 requests/s for 60 s per case (1,500 requests each), one at 100
requests/s (6,000 each), targets taking turns. Every response passed its checks, k6 dropped no
request, and the logs held every request. `node bench/report.ts <run>` prints the full tables.
"0.15.0" in this section is a build from before the release, at commit `e4b3e7f`; see Provenance.

**Calls per request.** The same in every round:

| Case     | 0.14.0: functions / billed | 0.15.0: functions / billed | static-hosting 0.2.1: functions / billed |
| -------- | -------------------------: | -------------------------: | ---------------------------------------: |
| page     |                      2 / 3 |                  **1 / 2** |                                    2 / 3 |
| asset    |                      2 / 3 |                  **1 / 2** |                                    2 / 3 |
| rendered |                      2 / 2 |                  **1 / 1** |                            cannot render |

**HTTP action time**, the median in ms of each round, from the deployment's logs:

| Case     | Rate  | 0.14.0     | 0.15.0     | static-hosting 0.2.1 |
| -------- | ----- | ---------- | ---------- | -------------------- |
| page     | 25/s  | 83.7, 94.2 | 57.6, 52.6 | 41.2, 41.8           |
| page     | 100/s | 85.8       | 50.4       | 40.9                 |
| asset    | 25/s  | 80.2, 77.7 | 52.4, 51.8 | 41.2, 41.9           |
| rendered | 25/s  | 38.5, 52.1 | 6.8, 6.5   |                      |
| rendered | 100/s | 37.1       | 6.3        |                      |

What the numbers say:

- **0.15.0 runs one function per request**; 0.14.0 and static-hosting run two. With the download of
  a stored body, which Convex bills too, a file costs 2 calls in place of 3, and a rendered page 1
  in place of 2. A flood of one million file requests is 2 million billed calls, not 3 million.
- **A rendered page is about 6 to 8 times faster** in the action (6.5 ms against 37 to 52 ms), since
  the action no longer waits for a query.
- **A file is about 30 ms faster than 0.14.0 and about 10 ms slower than static-hosting.**
  static-hosting's action runs inside the component, so it reads the file from storage directly; an
  app's action cannot read a component's storage, so 0.14.0 and 0.15.0 fetch the file's storage URL.
  The price of static-hosting's way is the second function, and that its component can hand a
  request to the app's code only as a buffered function call, so it renders no page.
- **Query cache.** static-hosting's `resolveAsset` takes only the path, so Convex answered all of
  its calls from the query cache (`cachedResult: true` in the logs), which is cheap in time but is
  still a call. 0.14.0's `route` takes the full URL, so a unique query string made every call run.
- **Client latency** includes the round trip from Chișinău; its tails moved between rounds by more
  than the targets differ (0.15.0 page p95: 734 ms in round 1, 248 ms in round 2), so the tables
  above use the deployment's own times.

**Large sites.** 0.15.0 carries the site's files in the pushed code, so its cost grows with the
number of files. The release's numbers are in [design](../docs/design.md), under "The site's files":
4.2 ms per request at 10,000 files and 7.5 ms at 100,000, against 3.8 ms for an empty action.
Measured here, on the build from before the release:

- a real 10,000-file site (a 0.89 MB `version.js`) served the same as 400 files: HTTP action median
  51.1 ms for the page, 51.3 ms for the asset, 6.7 ms for the rendered page, one function per
  request, every check passed (`2026-11-04-files-10000`);
- deploying those 10,000 files took 1,519 s: about 360 `npx convex run` calls, each its own process
  (`knownFiles` per 119 files, `generateUploadUrls` per 100, `recordFiles` per 60, and 5 pages of
  storage URLs), and the files themselves, four at a time. Deploy time grows with the file count;
  serving does not;
- 100,000 files is the most that the CLI accepts, Cloudflare's limit per Worker version.

**Provenance.** The 0.15.0 deployment of the 2026-11-04 runs was built at commit `e4b3e7f`, a week
before the release; the `commit` field of those results is the checkout's HEAD when each case ran.
The release serves the same way, one HTTP action and no query, but reads the site's files
differently: that build decoded only the entries of the manifest that a lookup touched, and the
release decodes the whole manifest for each request. The 2026-11-11 runs measure the release.
