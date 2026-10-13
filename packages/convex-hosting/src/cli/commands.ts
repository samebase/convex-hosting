import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { selectorArgs, type Target } from "./target.js";

/** The processes and network calls of the CLI. Tests pass fakes. */
export interface Cli {
  /** Runs `npx convex <args>` and resolves with its standard output. */
  convex: (args: string[]) => Promise<string>;
  /** Runs `npx convex <args>` with inherited standard streams and returns its exit status. */
  convexInherit: (args: string[], env: NodeJS.ProcessEnv) => number | null;
  fetch: typeof fetch;
}

/** The app's own Convex CLI, so the CLI version and the deployment settings match the app. */
function convexBinPath(): string {
  const requireFromApp = createRequire(join(process.cwd(), "package.json"));
  return join(dirname(requireFromApp.resolve("convex/package.json")), "bin", "main.js");
}

export const nodeCli: Cli = {
  convex: (args) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [convexBinPath(), ...args],
        // `function-spec` prints every function's validators.
        { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const output = (stderr || stdout || error.message).trim();
            reject(new Error(`npx convex ${args.join(" ")} failed:\n${output}`));
          } else {
            resolve(stdout.trim());
          }
        },
      );
    }),
  convexInherit: (args, env) =>
    spawnSync(process.execPath, [convexBinPath(), ...args], { env, stdio: "inherit" }).status,
  fetch: (input, init) => fetch(input, init),
};

/**
 * Runs a function of the component instance `component` on the target with `npx convex run` and
 * validates its result. `npx convex run` prints the result as JSON, and nothing for `null`.
 */
export async function runComponent<T>(
  cli: Cli,
  target: Target,
  component: string,
  functionName: string,
  args: Record<string, unknown>,
  result: z.ZodType<T>,
): Promise<T> {
  const output = await cli.convex([
    "run",
    "--component",
    component,
    functionName,
    JSON.stringify(args),
    "--typecheck=disable",
    "--codegen=disable",
    ...selectorArgs(target),
  ]);
  return result.parse(output === "" ? null : JSON.parse(output));
}
