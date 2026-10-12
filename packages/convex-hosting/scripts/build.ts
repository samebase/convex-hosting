import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hostingDirectory = fileURLToPath(new URL("../", import.meta.url));
const filesDirectory = fileURLToPath(new URL("../../convex-files/", import.meta.url));
const vendorDirectory = join(hostingDirectory, "vendor/files");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

function build(directory: string) {
  const result = spawnSync(process.execPath, [tsc, "--build", "tsconfig.build.json", "--force"], {
    cwd: directory,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await rm(join(filesDirectory, "dist"), { recursive: true, force: true });
build(filesDirectory);
await rm(vendorDirectory, { recursive: true, force: true });
await mkdir(vendorDirectory, { recursive: true });
await Promise.all([
  cp(join(filesDirectory, "src/component"), join(vendorDirectory, "src/component"), {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts"),
  }),
  cp(join(filesDirectory, "dist/component"), join(vendorDirectory, "dist/component"), {
    recursive: true,
  }),
]);
if (!process.argv.includes("--files-only")) build(hostingDirectory);
