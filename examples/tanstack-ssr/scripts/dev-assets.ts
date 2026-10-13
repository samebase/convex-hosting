// Rebuilds the app and uploads its client files whenever a source file
// changes, for `npm run dev`. Only one build and upload runs at a time. A
// change during a run starts one more run after it ends, so two builds never
// write `dist` at once and an older upload never activates over a newer one.

import { spawn } from "node:child_process";
import { mkdirSync, watch } from "node:fs";

let running = false;
let changedDuringRun = false;
let debounce: ReturnType<typeof setTimeout> | undefined;

function run() {
  if (running) {
    changedDuringRun = true;
    return;
  }
  running = true;
  spawn("pnpm run build && pnpm run upload", {
    shell: true,
    stdio: "inherit",
  }).on("exit", () => {
    running = false;
    if (changedDuringRun) {
      changedDuringRun = false;
      run();
    }
  });
}

function onChange() {
  clearTimeout(debounce);
  debounce = setTimeout(run, 500);
}

// The build rewrites the route tree, so a change to it must not start another
// build.
watch("src", { recursive: true }, (_event, file) => {
  if (file !== "routeTree.gen.ts") onChange();
});
// The example has no files in public/ yet, and a watch needs the directory.
mkdirSync("public", { recursive: true });
watch("public", { recursive: true }, onChange);
// Watch the directory, not the file: editors that save by replacing the file
// would end a watcher on the file itself.
watch(".", (_event, file) => {
  if (file === "vite.config.ts") onChange();
});
run();
