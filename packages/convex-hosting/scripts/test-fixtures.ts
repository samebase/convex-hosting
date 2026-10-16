// Runs Cloudflare's copied integration fixtures (the `fixtures` test project) and compares the
// outcome with fixtures-expected-failures.json: every listed test must fail, with its stated
// reason, and no other test may fail. A listed test that passes fails this run too, so the list
// never goes stale.
//
//   node scripts/test-fixtures.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Report = {
  testResults: {
    name: string;
    assertionResults: { fullName: string; status: string; failureMessages: string[] }[];
  }[];
};

const expected = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures-expected-failures.json"), "utf8"),
) as Record<string, string>;

const outputDirectory = mkdtempSync(join(tmpdir(), "fixtures-report-"));
const outputFile = join(outputDirectory, "report.json");
try {
  // The exit code says only whether a test failed; the report says which.
  spawnSync(
    "pnpm",
    [
      "exec",
      "vp",
      "test",
      "run",
      "--project",
      "fixtures",
      "--reporter=json",
      `--outputFile=${outputFile}`,
    ],
    { cwd: join(import.meta.dirname, "../../.."), stdio: "inherit" },
  );
  const report = JSON.parse(readFileSync(outputFile, "utf8")) as Report;

  const failed = new Map<string, string>();
  let total = 0;
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      total++;
      if (test.status === "failed") failed.set(test.fullName, test.failureMessages.join("\n"));
    }
  }
  if (total === 0) throw new Error("The fixtures project ran no test.");

  const problems: string[] = [];
  for (const [name, message] of failed) {
    if (!(name in expected)) problems.push(`Unexpected failure: ${name}\n${message}`);
  }
  for (const name of Object.keys(expected)) {
    if (!failed.has(name)) problems.push(`Expected to fail, but did not: ${name}`);
  }
  for (const problem of problems) console.error(`\n${problem}`);
  console.log(
    `\n${total} fixture tests: ${total - failed.size} passed, ${failed.size} failed, ${Object.keys(expected).length} expected to fail.`,
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
