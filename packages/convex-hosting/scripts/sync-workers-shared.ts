// Copies the parts of Cloudflare's Workers Static Assets implementation that this package uses
// from cloudflare/workers-sdk (packages/workers-shared, MIT OR Apache-2.0) into
// src/workers-shared, at the commit recorded in src/workers-shared/UPSTREAM.
//
//   node scripts/sync-workers-shared.ts [<commit>]
//
// The copied files keep their upstream paths, so their relative imports keep working. Test files
// get one mechanical change: they import from "vite-plus/test" instead of "vitest". The files in
// LOCAL_FILES are ours and are never overwritten.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPOSITORY = "https://github.com/cloudflare/workers-sdk.git";
const UPSTREAM_DIRECTORY = "packages/workers-shared";
const TARGET = join(import.meta.dirname, "../src/workers-shared");

/** Files copied from UPSTREAM_DIRECTORY, at the same relative path. */
const UPSTREAM_FILES = [
  "asset-worker/src/analytics.ts",
  "asset-worker/src/compatibility-flags.ts",
  "asset-worker/src/configuration.ts",
  "asset-worker/src/constants.ts",
  "asset-worker/src/handler.ts",
  "asset-worker/src/types.ts",
  "asset-worker/src/utils/base-path.ts",
  "asset-worker/src/utils/headers.ts",
  "asset-worker/src/utils/rules-engine.ts",
  "asset-worker/tests/analytics.test.ts",
  "asset-worker/tests/compatibility-flags.test.ts",
  "asset-worker/tests/handler.test.ts",
  "asset-worker/tests/rules-engine.test.ts",
  "utils/base-path.ts",
  "utils/configuration/constants.ts",
  "utils/configuration/constructConfiguration.ts",
  "utils/configuration/parseHeaders.ts",
  "utils/configuration/parseRedirects.ts",
  "utils/configuration/parseStaticRouting.ts",
  "utils/configuration/types.ts",
  "utils/configuration/validateURL.ts",
  "utils/constants.ts",
  "utils/helpers.ts",
  "utils/responses.ts",
  "utils/testdata/base-path-normalization.json",
  "utils/tests/base-path.test.ts",
  "utils/tests/helpers.test.ts",
  "utils/tests/parseHeaders.invalid.test.ts",
  "utils/tests/parseHeaders.valid.test.ts",
  "utils/tests/parseRedirects.invalid.test.ts",
  "utils/tests/parseRedirects.valid.test.ts",
  "utils/tests/parseStaticRouting.test.ts",
  "utils/tracing.ts",
  "utils/types.ts",
];

/** Files copied from the repository root. */
const LICENSE_FILES = ["LICENSE-APACHE", "LICENSE-MIT"];

/** Our own files in the target folder. The sync keeps them. */
const LOCAL_FILES = ["UPSTREAM", "asset-worker/src/worker.ts"];

function readUpstreamCommit(): string {
  const upstream = readFileSync(join(TARGET, "UPSTREAM"), "utf8");
  const commit = /^commit: ([0-9a-f]{40})$/m.exec(upstream)?.[1];
  if (!commit) throw new Error("UPSTREAM has no commit line.");
  return commit;
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

const commit = process.argv[2] ?? readUpstreamCommit();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Not a full commit hash: ${commit}`);

const checkout = mkdtempSync(join(tmpdir(), "workers-shared-"));
try {
  git(checkout, "init", "--quiet");
  git(checkout, "remote", "add", "origin", REPOSITORY);
  git(checkout, "sparse-checkout", "set", UPSTREAM_DIRECTORY);
  git(checkout, "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", commit);
  git(checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD");

  const keep = new Set(LOCAL_FILES);
  const localContents = new Map(
    LOCAL_FILES.flatMap((file) => {
      try {
        return [[file, readFileSync(join(TARGET, file), "utf8")] as const];
      } catch {
        return [];
      }
    }),
  );
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  for (const [file, contents] of localContents) {
    if (!keep.has(file)) continue;
    mkdirSync(dirname(join(TARGET, file)), { recursive: true });
    writeFileSync(join(TARGET, file), contents);
  }

  for (const file of UPSTREAM_FILES) {
    const source = join(checkout, UPSTREAM_DIRECTORY, file);
    const target = join(TARGET, file);
    mkdirSync(dirname(target), { recursive: true });
    if (file.endsWith(".test.ts")) {
      const contents = readFileSync(source, "utf8").replaceAll(
        'from "vitest"',
        'from "vite-plus/test"',
      );
      writeFileSync(target, contents);
    } else {
      cpSync(source, target);
    }
  }
  for (const file of LICENSE_FILES) {
    cpSync(join(checkout, file), join(TARGET, file));
  }

  writeFileSync(
    join(TARGET, "UPSTREAM"),
    [
      "Copied from https://github.com/cloudflare/workers-sdk, packages/workers-shared.",
      "License: MIT OR Apache-2.0 (LICENSE-MIT, LICENSE-APACHE).",
      `commit: ${commit}`,
      `synced: ${new Date().toISOString().slice(0, 10)}`,
      "",
      "Run `node scripts/sync-workers-shared.ts [<commit>]` from packages/convex-hosting to update.",
      "Test files import from vite-plus/test instead of vitest. asset-worker/src/worker.ts is ours:",
      "it declares the types that handler.ts imports from the upstream entrypoint.",
      "",
    ].join("\n"),
  );
  console.log(`Synced ${UPSTREAM_FILES.length} files at ${commit.slice(0, 12)}.`);
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
