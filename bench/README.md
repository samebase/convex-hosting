# Benchmark

What one request to a hosted site costs on Convex, for three ways to serve it:

- **convex-hosting 0.14.0**, from npm: the HTTP action asks the component's `route` query which file
  answers.
- **convex-hosting 0.15.0**, this branch, packed: the HTTP action answers from the site's files,
  which the deploy writes into the pushed code.
- **@convex-dev/static-hosting 0.2.1**, from npm, mounted at `/`
  (`app.use(staticHosting, { httpPrefix: "/" })`), the mode its README calls the fastest: the
  component's own HTTP action runs its `resolveAsset` query and reads the file from storage.

Convex bills function calls: every query, mutation, action, and HTTP action, and every download of a
stored file ([usage limits](https://docs.convex.dev/production/usage-limits)). A flood against a
site spends them, so calls per request decide what a flood costs, and when the team's spending limit
turns every project off.

## Method

- **One Convex cloud project per target**, each with its own development deployment, created by
  `run.ts`: `convex-hosting-bench-014`, `convex-hosting-bench` (this branch), and
  `convex-hosting-bench-static`. Convex 1.46.0 in each app.
- **The same synthetic site** for all three, from `site.ts`: `index.html`, `404.html`, and 400
  scripts of about 2 KB with Vite-style hashed names, every file with its own bytes.
- **Cases.** `page`: `GET /` with `Sec-Fetch-Mode: navigate`, answered by `index.html`. `asset`:
  `GET` of a hashed script. `rendered`: `GET /rendered` with `Sec-Fetch-Mode: navigate`, a path with
  no file, answered by the app's code; the convex-hosting apps pass a worker that returns one small
  page, so the case measures hosting and not a framework. static-hosting renders no page, so it has
  no `rendered` case.
- **No cache answers.** Each request carries a unique query string, so the Cloudflare front of
  `*.convex.site` passes every request to the HTTP action, as it does in a flood.
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
deploys; `--no-deploy` reuses the deployed site. `bench/.work/` holds the apps and the packed branch
build; `bench/results/<run>/` holds one JSON file per case and k6's own summary next to it.

## Results, 2026-11-04

400 files. Two rounds at 25 requests/s for 60 s per case (1,500 requests each), one at 100
requests/s (6,000 each), targets taking turns. Every response passed its checks, k6 dropped no
request, and the logs held every request. `node bench/report.ts <run>` prints the full tables.

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
  The price of static-hosting's way is the second function, and that its component cannot hand a
  request to the app's code, so it renders no page.
- **Query cache.** static-hosting's `resolveAsset` takes only the path, so Convex answered all of
  its calls from the query cache (`cachedResult: true` in the logs), which is cheap in time but is
  still a call. 0.14.0's `route` takes the full URL, so a unique query string made every call run.
- **Client latency** includes the round trip from Chișinău; its tails moved between rounds by more
  than the targets differ (0.15.0 page p95: 734 ms in round 1, 248 ms in round 2), so the tables
  above use the deployment's own times.

**Large sites.** 0.15.0 carries the site's files in the pushed code, so its cost grows with the
number of files. Measured on the same cloud deployment:

- a site object of 100,000 files is an 8.9 MB module; it pushed in 4 s, and each request ran about 2
  ms longer (median 5.6 ms against 3.6 ms for a minimal action, 40 sequential requests each);
- memory: a request could hold 86 MiB of arrays without the 100,000-file site and 77 MiB with it,
  the same on two runs each, so the site takes about 9 MiB;
- 100,000 files is the most that the CLI accepts, Cloudflare's limit per Worker version.

**Provenance.** The 0.15.0 deployment of the 400-file runs was built at commit `e4b3e7f`; the
`commit` field of those results is the checkout's HEAD when each case ran. The serving code
(`src/client/index.ts`, and `lookup` in `src/client/manifest.ts`) is the same at the head of the
pull request; later commits changed the CLI and the builder only.
