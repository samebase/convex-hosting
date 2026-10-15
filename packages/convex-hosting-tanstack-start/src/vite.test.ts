// @vitest-environment node
// The plugin runs in Node; the edge-runtime environment of the other tests has no `process`.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, test, vi } from "vite-plus/test";
import { convexSsr } from "./vite.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Runs the plugin's `writeBundle` for the `ssr` environment with a working directory of its own,
 * the server build in `build/server` under it, and these entry chunks, and returns the directory.
 */
async function writeServerBuild(entries: string[], input: string) {
  // Vitest runs the tests in worker threads, where `process.chdir` throws.
  const cwd = mkdtempSync(join(tmpdir(), "convex-ssr-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const { writeBundle } = convexSsr();
  assert(typeof writeBundle === "function");
  const context = {
    environment: { name: "ssr", config: { build: { rolldownOptions: { input } } } },
  };
  const options = { dir: join(cwd, "build", "server") };
  const bundle = Object.fromEntries(
    [...entries, "assets/routes-1a2b3c.mjs"].map((fileName) => [
      fileName,
      {
        type: "chunk",
        isEntry: entries.includes(fileName),
        name: fileName.split(".")[0],
        fileName,
      },
    ]),
  );
  // @ts-expect-error The hook reads only these fields of its context, options, and chunks.
  await writeBundle.call(context, options, bundle);
  return cwd;
}

const reExport = (path: string) =>
  `// Written by convexSsr() after the server build.\nexport { default } from "${path}";\n`;

test("re-exports the entry chunk by its emitted name, from the working directory", async () => {
  const cwd = await writeServerBuild(["server.mjs"], "/app/src/server.ts");
  expect(readFileSync(join(cwd, ".convex-hosting", "server.js"), "utf8")).toBe(
    reExport("../build/server/server.mjs"),
  );
  expect(readFileSync(join(cwd, ".convex-hosting", ".gitignore"), "utf8")).toBe("*\n");
});

test("picks the entry named after the environment's input among several", async () => {
  const cwd = await writeServerBuild(["worker.js", "entry.js"], "/app/src/entry.tsx");
  expect(readFileSync(join(cwd, ".convex-hosting", "server.js"), "utf8")).toBe(
    reExport("../build/server/entry.js"),
  );
});
