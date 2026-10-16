// Copies the parts of Cloudflare's Workers Static Assets implementation that this package uses
// from cloudflare/workers-sdk (MIT OR Apache-2.0) into src/workers-sdk, at the commit recorded in
// src/workers-sdk/UPSTREAM: the asset Worker and its tests from packages/workers-shared, and
// Cloudflare's html_handling and encoding cases from fixtures/workers-shared-asset-config, which
// src/component/conformance.test.ts runs through `route`.
//
//   node scripts/sync-workers-sdk.ts [<commit>]
//
// src/workers-sdk mirrors the repository tree: a file is at the path it has upstream, so its
// relative imports keep working and its upstream location is its path. The `.ts`
// files get three mechanical changes, and nothing else differs from upstream:
//
// - Relative import and export specifiers without an extension get `.js` (`"./types"` becomes
//   `"./types.js"`), because Node's ESM loader runs the built CLI and needs the extension. A
//   specifier with an extension, such as `.json`, stays as is.
// - Test files import from "vite-plus/test" instead of "vitest".
// - The test-cases files import their `TestCase` type with `import type`, which
//   `verbatimModuleSyntax` requires; upstream writes `import { TestCase }`.
//
// The files in LOCAL_FILES are ours and are never overwritten.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

const REPOSITORY = "https://github.com/cloudflare/workers-sdk.git";
const UPSTREAM_DIRECTORIES = ["packages/workers-shared", "fixtures/workers-shared-asset-config"];
const TARGET = join(import.meta.dirname, "../src/workers-sdk");

/** Files copied from the repository, at their repository path. */
const UPSTREAM_FILES = [
  "fixtures/workers-shared-asset-config/test-cases/encoding-test-cases.ts",
  "fixtures/workers-shared-asset-config/test-cases/html-handling-test-cases.ts",
  "packages/workers-shared/asset-worker/src/analytics.ts",
  "packages/workers-shared/asset-worker/src/compatibility-flags.ts",
  "packages/workers-shared/asset-worker/src/configuration.ts",
  "packages/workers-shared/asset-worker/src/constants.ts",
  "packages/workers-shared/asset-worker/src/handler.ts",
  "packages/workers-shared/asset-worker/src/types.ts",
  "packages/workers-shared/asset-worker/src/utils/base-path.ts",
  "packages/workers-shared/asset-worker/src/utils/headers.ts",
  "packages/workers-shared/asset-worker/src/utils/rules-engine.ts",
  "packages/workers-shared/asset-worker/tests/analytics.test.ts",
  "packages/workers-shared/asset-worker/tests/compatibility-flags.test.ts",
  "packages/workers-shared/asset-worker/tests/handler.test.ts",
  "packages/workers-shared/asset-worker/tests/rules-engine.test.ts",
  "packages/workers-shared/utils/base-path.ts",
  "packages/workers-shared/utils/configuration/constants.ts",
  "packages/workers-shared/utils/configuration/constructConfiguration.ts",
  "packages/workers-shared/utils/configuration/parseHeaders.ts",
  "packages/workers-shared/utils/configuration/parseRedirects.ts",
  "packages/workers-shared/utils/configuration/parseStaticRouting.ts",
  "packages/workers-shared/utils/configuration/types.ts",
  "packages/workers-shared/utils/configuration/validateURL.ts",
  "packages/workers-shared/utils/constants.ts",
  "packages/workers-shared/utils/helpers.ts",
  "packages/workers-shared/utils/responses.ts",
  "packages/workers-shared/utils/testdata/base-path-normalization.json",
  "packages/workers-shared/utils/tests/base-path.test.ts",
  "packages/workers-shared/utils/tests/helpers.test.ts",
  "packages/workers-shared/utils/tests/parseHeaders.invalid.test.ts",
  "packages/workers-shared/utils/tests/parseHeaders.valid.test.ts",
  "packages/workers-shared/utils/tests/parseRedirects.invalid.test.ts",
  "packages/workers-shared/utils/tests/parseRedirects.valid.test.ts",
  "packages/workers-shared/utils/tests/parseStaticRouting.test.ts",
  "packages/workers-shared/utils/tracing.ts",
  "packages/workers-shared/utils/types.ts",
];

/** Files copied from the repository root. */
const LICENSE_FILES = ["LICENSE-APACHE", "LICENSE-MIT"];

/** Our own files in the target folder. The sync keeps them. */
const LOCAL_FILES = [
  "UPSTREAM",
  "packages/workers-shared/asset-worker/src/worker.ts",
  "fixtures/workers-shared-asset-config/html-handling.test.d.ts",
];

/** A relative specifier in `from "./types"`, `import "./polyfill"`, or `import("./module")`. */
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/g;

/** Adds `.js` to every relative specifier without an extension. */
function addJsExtensions(source: string): string {
  return source.replace(
    RELATIVE_SPECIFIER,
    (match, keyword: string, quote: string, specifier: string) =>
      extname(specifier) === "" ? `${keyword}${quote}${specifier}.js${quote}` : match,
  );
}

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
  git(checkout, "sparse-checkout", "set", ...UPSTREAM_DIRECTORIES);
  git(checkout, "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", commit);
  git(checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD");

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
    mkdirSync(dirname(join(TARGET, file)), { recursive: true });
    writeFileSync(join(TARGET, file), contents);
  }

  for (const file of UPSTREAM_FILES) {
    const source = join(checkout, file);
    const target = join(TARGET, file);
    mkdirSync(dirname(target), { recursive: true });
    if (file.endsWith(".ts")) {
      let contents = addJsExtensions(readFileSync(source, "utf8"));
      if (file.endsWith(".test.ts")) {
        contents = contents.replaceAll('from "vitest"', 'from "vite-plus/test"');
      }
      if (file.includes("/test-cases/")) {
        contents = contents.replace(
          /^import \{ TestCase \} from/m,
          "import type { TestCase } from",
        );
      }
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
      "Copied from https://github.com/cloudflare/workers-sdk, at the paths the files have there:",
      "packages/workers-shared, and the test cases of fixtures/workers-shared-asset-config.",
      "License: MIT OR Apache-2.0 (LICENSE-MIT, LICENSE-APACHE).",
      `commit: ${commit}`,
      `synced: ${new Date().toISOString().slice(0, 10)}`,
      "",
      "Run `node scripts/sync-workers-sdk.ts [<commit>]` from packages/convex-hosting to update.",
      "Relative import and export specifiers without an extension get .js, for Node's ESM loader.",
      "Test files import from vite-plus/test instead of vitest. The test-cases files import their",
      "TestCase type with `import type`. Ours: packages/workers-shared/asset-worker/src/worker.ts",
      "declares the types that handler.ts imports from the upstream entrypoint, and",
      "fixtures/workers-shared-asset-config/html-handling.test.d.ts holds the TestCase type at the",
      "path the test-cases files import it from.",
      "",
    ].join("\n"),
  );
  console.log(`Synced ${UPSTREAM_FILES.length} files at ${commit.slice(0, 12)}.`);
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
