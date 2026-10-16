// Runs Cloudflare's copied integration fixtures (the `fixtures` test project) in two passes and
// compares the outcome with fixtures-expected-failures.json, which lists the tests that fail by a
// stated difference from Cloudflare. The first pass runs every test but the listed ones, and every
// test must pass; the second runs only the listed ones, and each must fail, so the list never goes
// stale. In both passes a suite error (a hook that throws, a file that does not load) or an
// unhandled error fails the run: vitest's programmatic API reports them, its JSON report does not.
//
//   node scripts/test-fixtures.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startVitest } from "vite-plus/test/node";

const ROOT = join(import.meta.dirname, "../../..");

const expected = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures-expected-failures.json"), "utf8"),
) as Record<string, string>;
const listed = Object.keys(expected);

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Matches a full test name that is not listed, or only a listed one. A full name is the describe
 * titles and the test title joined with " > ", the form `testNamePattern` matches against.
 */
const unlistedPattern =
  listed.length === 0 ? undefined : new RegExp(`^(?!(?:${listed.map(escape).join("|")})$)`);
const listedPattern = new RegExp(`^(?:${listed.map(escape).join("|")})$`);

/** A task of the run: a test with its outcome, or a suite or file that failed outside its tests. */
type Outcome = { tests: Map<string, string>; errors: string[] };

/** Runs the fixtures project once, with a test-name filter, and collects the outcome. */
async function run(pass: string, testNamePattern: RegExp | undefined): Promise<Outcome> {
  console.log(`\n== ${pass}`);
  const vitest = await startVitest("test", [], {
    root: ROOT,
    run: true,
    watch: false,
    project: ["fixtures"],
    testNamePattern,
  });
  if (vitest === undefined) throw new Error("vitest did not start.");
  await vitest.close();

  const outcome: Outcome = { tests: new Map(), errors: [] };
  const visit = (task: {
    type: string;
    name: string;
    mode: string;
    tasks?: unknown[];
    result?: { state: string; errors?: { message: string }[] };
    suite?: { name: string; suite?: unknown };
  }) => {
    const names: string[] = [];
    for (let parent = task.suite; parent !== undefined; parent = parent.suite as typeof parent) {
      names.unshift(parent.name);
    }
    const fullName = [...names, task.name].join(" > ");
    if (task.type === "test") {
      if (task.mode !== "skip" && task.result !== undefined) {
        outcome.tests.set(fullName, task.result.state);
      }
      return;
    }
    for (const error of task.result?.errors ?? []) {
      outcome.errors.push(`${fullName}: ${error.message}`);
    }
    for (const child of task.tasks ?? []) visit(child as typeof task);
  };
  for (const file of vitest.state.getFiles()) {
    for (const error of file.result?.errors ?? [])
      outcome.errors.push(`${file.name}: ${error.message}`);
    for (const child of file.tasks) visit(child);
  }
  for (const error of vitest.state.getUnhandledErrors()) {
    outcome.errors.push(`Unhandled: ${(error as { message?: string }).message ?? String(error)}`);
  }
  return outcome;
}

const problems: string[] = [];

const unlisted = await run("Every test not listed as an expected failure", unlistedPattern);
if (unlisted.tests.size === 0) problems.push("The fixtures project ran no test.");
for (const [name, state] of unlisted.tests) {
  if (state !== "pass") problems.push(`Failed: ${name}`);
}
problems.push(...unlisted.errors);

if (listed.length > 0) {
  const expectedRun = await run("The listed expected failures", listedPattern);
  for (const name of listed) {
    const state = expectedRun.tests.get(name);
    if (state === undefined) problems.push(`Listed, but no test has this name: ${name}`);
    else if (state !== "fail") problems.push(`Listed, but did not fail (${state}): ${name}`);
  }
  problems.push(...expectedRun.errors);
}

for (const problem of problems) console.error(`\n${problem}`);
console.log(
  `\n${unlisted.tests.size} fixture tests ran${listed.length > 0 ? `, ${listed.length} expected failures checked` : ""}.`,
);
process.exit(problems.length === 0 ? 0 : 1);
