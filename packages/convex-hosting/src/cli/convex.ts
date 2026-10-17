import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  type FunctionType,
} from "convex/server";
import { z } from "zod";

/** The processes and network calls of the CLI. Tests pass fakes. */
export interface Cli {
  /** The app's directory, with `convex/` and `.env.local`. */
  cwd: string;
  /** The process environment. */
  env: Record<string, string | undefined>;
  /** Runs the app's `convex` CLI and captures its output. */
  convex: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Runs the app's `convex` CLI with this process's standard streams; resolves with its exit code. */
  convexInherited: (args: string[]) => Promise<number>;
  /**
   * Starts the app's `convex` CLI with this process's standard streams and leaves it running:
   * `exited` resolves with its exit code, `stop` interrupts it. While it runs, an interrupt of this
   * process is passed to it and this process waits for it, so the exit code is the child's.
   */
  convexChild: (args: string[]) => { exited: Promise<number>; stop: () => void };
  /** Reads `.env.local`, the file the Convex CLI writes when it configures a deployment. */
  envLocal: () => Record<string, string | undefined>;
  /**
   * Runs a shell command in `cwd` with this process's environment and standard streams; resolves
   * with its exit code.
   */
  shell: (command: string) => Promise<number>;
  fetch: typeof fetch;
  /** Writes a line to standard error. */
  log: (message: string) => void;
}

/** The app's own Convex CLI, so the CLI version and the deployment settings match the app. */
function convexBin(cwd: string): string {
  const requireFromApp = createRequire(join(cwd, "package.json"));
  return join(dirname(requireFromApp.resolve("convex/package.json")), "bin", "main.js");
}

export const nodeCli: Cli = {
  cwd: process.cwd(),
  env: process.env,
  convex: (args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [convexBin(process.cwd()), ...args],
        { encoding: "utf8" },
        (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ exitCode, stdout, stderr });
        },
      );
    }),
  convexInherited: (args) =>
    attended(spawn(process.execPath, [convexBin(process.cwd()), ...args], { stdio: "inherit" }))
      .exited,
  convexChild: (args) =>
    attended(spawn(process.execPath, [convexBin(process.cwd()), ...args], { stdio: "inherit" })),
  envLocal: () => {
    const path = join(process.cwd(), ".env.local");
    return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  },
  shell: (command) => attended(spawn(command, { shell: true, stdio: "inherit" })).exited,
  fetch: (input, init) => fetch(input, init),
  log: (message) => console.error(message),
};

/** Set once this process was told to stop; no further process starts after that. */
let interrupted = false;

/**
 * A child with this process's standard streams, attended until it ends: an interrupt or a
 * termination of this process is passed to it and this process outlives it, so the exit code is
 * the child's. The terminal interrupts the whole foreground group, a supervisor only this process;
 * either way the child gets the signal. After a signal no process starts: the step that would have
 * followed fails instead.
 */
function attended(child: ChildProcess): { exited: Promise<number>; stop: () => void } {
  if (interrupted) throw new Error("Interrupted.");
  const forward = (signal: NodeJS.Signals) => {
    interrupted = true;
    child.kill(signal);
  };
  process.on("SIGINT", forward).on("SIGTERM", forward);
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject).on("close", (code) => resolve(code ?? 1));
  }).finally(() => void process.off("SIGINT", forward).off("SIGTERM", forward));
  return { exited, stop: () => void child.kill("SIGINT") };
}

/**
 * The variables that the Convex CLI reads to select a deployment, in its order: the process
 * environment first, then `.env.local`, then `.env`.
 */
export function readConvexEnv(cli: Cli): Record<string, string | undefined> {
  const fromFile = (name: string) => {
    const path = join(cli.cwd, name);
    return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  };
  return { ...fromFile(".env"), ...fromFile(".env.local"), ...cli.env };
}

/** The deployment of a deploy: production by default, `--preview-name <name>`, or `--dev`. */
export type Destination =
  | { kind: "production" }
  | { kind: "preview"; name: string }
  | { kind: "dev" };

/**
 * The deployment selector of a deploy's `npx convex run` calls. Production gets `--prod`, because
 * `npx convex deploy` goes to production by default while `npx convex run` goes to development; a
 * preview gets `--preview-name <name>`; the development deployment, which `npx convex run` picks
 * from `.env.local`, gets none. A deploy key in the environment wins over the selector. A
 * self-hosted deployment takes no selector.
 */
export function deploymentSelector(cli: Cli, destination: Destination): string[] {
  if (readConvexEnv(cli).CONVEX_SELF_HOSTED_URL) return [];
  switch (destination.kind) {
    case "production":
      return ["--prod"];
    case "preview":
      return ["--preview-name", destination.name];
    case "dev":
      return [];
    default:
      return destination satisfies never;
  }
}

/** The component instance and the deployment that every call of one command reaches. */
export type Target = { component: string; flags: string[] };

/**
 * Probes whether the deployment has the component instance: `undefined` when it has it, and the
 * Convex CLI's output when it does not, which lists the components the deployment has. This probe
 * exists because a function run against a missing component answers a generic
 * `InternalServerError` ("Your request couldn't be completed"), while the Convex CLI's own
 * component lookup for `--inline-query` prints `Component path "<name>" was not found.` The probe
 * is an inline query that reads nothing. Any other failure is an error.
 */
export async function probeComponent(cli: Cli, target: Target): Promise<string | undefined> {
  const { exitCode, stdout, stderr } = await cli.convex([
    "run",
    "--component",
    target.component,
    "--inline-query",
    "null",
    ...target.flags,
  ]);
  if (exitCode === 0) return undefined;
  const output = `${stderr}\n${stdout}`.trim();
  if (output.includes(`Component path "${target.component}" was not found.`)) return output;
  throw new Error(stderr.trim() || stdout.trim() || `npx convex run exited with ${exitCode}.`);
}

/**
 * The site URL, as the deployment gives it to its own functions in `CONVEX_SITE_URL`: an inline
 * query at the app's root, with the deploy's selector. So it is right for every kind of deployment,
 * and it is the custom domain when the dashboard's "Override Environment Variables" sets one.
 */
export async function siteUrl(cli: Cli, flags: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await cli.convex([
    "run",
    "--inline-query",
    "process.env.CONVEX_SITE_URL",
    ...flags,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `npx convex run exited with ${exitCode}.`);
  }
  return z.string().parse(JSON.parse(stdout));
}

/**
 * Runs a function of the component with `npx convex run` and validates its result. The Convex CLI
 * prints the result as JSON from another process, so `result` checks it at runtime; its type makes
 * the schema agree with the function's declared return. The CLI prints nothing for `null`.
 */
export async function runComponent<Ref extends FunctionReference<FunctionType, "internal">>(
  cli: Cli,
  target: Target,
  ref: Ref,
  args: FunctionArgs<Ref>,
  result: z.ZodType<FunctionReturnType<Ref>>,
): Promise<FunctionReturnType<Ref>> {
  const functionName = getFunctionName(ref);
  const { exitCode, stdout, stderr } = await cli.convex([
    "run",
    "--component",
    target.component,
    functionName,
    JSON.stringify(args),
    ...target.flags,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || stdout.trim() || `npx convex run ${functionName} exited with ${exitCode}.`,
    );
  }
  return result.parse(stdout.trim() === "" ? null : JSON.parse(stdout));
}
