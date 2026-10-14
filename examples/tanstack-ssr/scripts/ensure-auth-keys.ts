import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

type RunConvex = (args: string[], input?: string) => string;

function runConvexCli(args: string[], input?: string): string {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("convex/package.json")), "bin", "main.js");
  const result = spawnSync(process.execPath, [cli, ...args], {
    shell: false,
    encoding: "utf8",
    stdio: "pipe",
    input,
  });
  // CLI output can contain secrets, including on failure. Report only the command and status.
  if (result.error || result.status !== 0) {
    throw new Error(
      `convex ${args.join(" ")} failed${result.status === null ? "" : ` with exit code ${result.status}`}. Check your Convex credentials and deployment.`,
    );
  }
  return result.stdout;
}

export function generateAuthKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
  return {
    AUTH_PRIVATE_KEY: Buffer.from(privatePem).toString("base64"),
    AUTH_JWKS: JSON.stringify({
      keys: [
        { ...publicKey.export({ format: "jwk" }), kid: randomUUID(), alg: "RS256", use: "sig" },
      ],
    }),
  };
}

export function ensureAuthKeys(runConvex: RunConvex = runConvexCli) {
  // The CLI selects the deployment from CONVEX_DEPLOY_KEY or the local development settings.
  // A missing variable exits successfully with empty stdout; a failed read must stop setup.
  const privateKey = runConvex(["env", "get", "AUTH_PRIVATE_KEY"]).trim();
  const jwks = runConvex(["env", "get", "AUTH_JWKS"]).trim();
  if (privateKey && jwks) return "existing";
  if (privateKey || jwks) {
    throw new Error(
      "AUTH_PRIVATE_KEY and AUTH_JWKS must be configured together. Restore the missing value from the same key pair before retrying.",
    );
  }

  const keys = generateAuthKeys();
  // Send both values in one request through stdin. Without --force, the CLI checks for conflicts.
  runConvex(
    ["env", "set"],
    `AUTH_PRIVATE_KEY='${keys.AUTH_PRIVATE_KEY}'\nAUTH_JWKS='${keys.AUTH_JWKS}'\n`,
  );
  return "created";
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const result = ensureAuthKeys();
    process.stdout.write(
      result === "existing"
        ? "Convex Auth keys already configured.\n"
        : "Convex Auth keys configured.\n",
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Could not configure Convex Auth keys."}\n`,
    );
    process.exitCode = 1;
  }
}
