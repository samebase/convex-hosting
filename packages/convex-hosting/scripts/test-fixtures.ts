// Runs Cloudflare's copied integration fixtures (the `fixtures` test project) in two passes and
// compares the outcome with fixtures-expected-failures.json, which lists the tests that fail by a
// stated difference from Cloudflare. The first pass runs every test but the listed ones and must
// pass as a whole, so a hook error or a collection error fails it like a test does. The second
// pass runs only the listed tests, and each must fail, so the list never goes stale.
//
//   node scripts/test-fixtures.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Report = {
  testResults: {
    assertionResults: { ancestorTitles: string[]; title: string; status: string }[];
  }[];
};

const ROOT = join(import.meta.dirname, "../../..");

const expected = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures-expected-failures.json"), "utf8"),
) as Record<string, string>;
const listed = Object.keys(expected);

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Matches a full test name that is not listed, or only a listed one. A full name is the describe
 * titles and the test title joined with " > ", the form `--testNamePattern` matches against.
 */
const unlistedPattern = listed.length === 0 ? "" : `^(?!(?:${listed.map(escape).join("|")})$)`;
const listedPattern = `^(?:${listed.map(escape).join("|")})$`;

const reportDirectory = mkdtempSync(join(tmpdir(), "fixtures-report-"));

/** Runs the fixtures project with a test-name filter; returns the exit code and the report. */
function run(pass: string, pattern: string): { exitCode: number; report: Report } {
  const outputFile = join(reportDirectory, `${pass}.json`);
  console.log(`\n== ${pass}`);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vp",
      "test",
      "run",
      "--project",
      "fixtures",
      ...(pattern === "" ? [] : ["--testNamePattern", pattern]),
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${outputFile}`,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  return {
    exitCode: result.status ?? 1,
    report: JSON.parse(readFileSync(outputFile, "utf8")) as Report,
  };
}

function statuses(report: Report): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      map.set([...test.ancestorTitles, test.title].join(" > "), test.status);
    }
  }
  return map;
}

try {
  const problems: string[] = [];

  const unlisted = run("Every test not listed as an expected failure", unlistedPattern);
  const ranUnlisted = new Map(
    [...statuses(unlisted.report)].filter(([, status]) => status !== "skipped"),
  );
  if (ranUnlisted.size === 0) problems.push("The fixtures project ran no test.");
  if (unlisted.exitCode !== 0) {
    const failed = [...ranUnlisted].filter(([, status]) => status === "failed").map(([n]) => n);
    problems.push(
      failed.length === 0
        ? "The run failed outside a test: a hook, a collection, or the runner."
        : `Failed:\n  ${failed.join("\n  ")}`,
    );
  }

  if (listed.length > 0) {
    const expectedRun = run("The listed expected failures", listedPattern);
    const ranListed = statuses(expectedRun.report);
    for (const name of listed) {
      const status = ranListed.get(name);
      if (status === undefined) problems.push(`Listed, but no test has this name: ${name}`);
      else if (status !== "failed") problems.push(`Listed, but did not fail (${status}): ${name}`);
    }
  }

  for (const problem of problems) console.error(`\n${problem}`);
  console.log(
    `\n${ranUnlisted.size} fixture tests ran${listed.length > 0 ? `, ${listed.length} expected failures checked` : ""}.`,
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
} finally {
  rmSync(reportDirectory, { recursive: true, force: true });
}
