import { parseArgs } from "node:util";
import { normalizeBasePath } from "../workers-shared/utils/base-path.js";
import { AssetConfigSchema, type AssetConfig } from "../workers-shared/utils/types.js";
import { VERSION_ID_PATTERN } from "./manifest.js";

/** Options shared by `upload` and `deploy`: what to upload, where, and how to serve it. */
export interface SiteOptions {
  dist: string;
  component: string;
  previewName: string | null;
  /** A preset name (`vite`, `next`, `astro`, `sveltekit`) or a gitignore-style glob. */
  immutable: string;
  htmlHandling: NonNullable<AssetConfig["html_handling"]>;
  notFoundHandling: NonNullable<AssetConfig["not_found_handling"]>;
  /** Normalized by the asset worker's rules: `/` or `/prefix/`. */
  basePath: string;
}

export interface UploadOptions extends SiteOptions {
  versionId: string | null;
  activate: boolean;
}

export interface DeployOptions extends SiteOptions {
  buildCommand: string;
  verifyPath: string;
}

const siteOptionConfig = {
  dist: { type: "string" },
  component: { type: "string" },
  "preview-name": { type: "string" },
  immutable: { type: "string" },
  "html-handling": { type: "string" },
  "not-found-handling": { type: "string" },
  "base-path": { type: "string" },
} as const;

type SiteValues = { [Key in keyof typeof siteOptionConfig]?: string };

function parseSiteOptions(values: SiteValues): SiteOptions {
  if (values.dist === undefined) throw new Error("--dist <dir> is required.");
  const basePath = normalizeBasePath(values["base-path"] ?? "/");
  if (!basePath.valid) throw new Error(`--base-path: ${basePath.error}`);
  return {
    dist: values.dist,
    component: values.component ?? "hosting",
    previewName: values["preview-name"] ?? null,
    immutable: values.immutable ?? "vite",
    htmlHandling: parseChoice(
      "--html-handling",
      AssetConfigSchema.shape.html_handling.unwrap().options,
      values["html-handling"] ?? "auto-trailing-slash",
    ),
    notFoundHandling: parseChoice(
      "--not-found-handling",
      AssetConfigSchema.shape.not_found_handling.unwrap().options,
      values["not-found-handling"] ?? "none",
    ),
    basePath: basePath.value,
  };
}

function parseChoice<const Choice extends string>(
  flag: string,
  choices: readonly Choice[],
  value: string,
): Choice {
  const choice = choices.find((candidate) => candidate === value);
  if (choice === undefined) throw new Error(`${flag} must be one of: ${choices.join(", ")}.`);
  return choice;
}

export function parseUploadArgs(args: string[]): UploadOptions {
  const { values } = parseArgs({
    args,
    options: {
      ...siteOptionConfig,
      "version-id": { type: "string" },
      "no-activate": { type: "boolean" },
    },
  });
  const versionId = values["version-id"] ?? null;
  if (versionId !== null && !VERSION_ID_PATTERN.test(versionId)) {
    throw new Error("--version-id must be v_ followed by 26 characters from a-z and 2-7.");
  }
  return { ...parseSiteOptions(values), versionId, activate: !values["no-activate"] };
}

export function parseDeployArgs(args: string[]): DeployOptions {
  const { values } = parseArgs({
    args,
    options: {
      ...siteOptionConfig,
      "build-command": { type: "string" },
      "verify-path": { type: "string" },
    },
  });
  const verifyPath = values["verify-path"] ?? "/";
  if (!verifyPath.startsWith("/")) throw new Error("--verify-path must start with /.");
  return {
    ...parseSiteOptions(values),
    buildCommand: values["build-command"] ?? "npm run build",
    verifyPath,
  };
}

/** The `upload` flags that give an `upload` subprocess the same site options. */
export function siteOptionArgs(options: SiteOptions): string[] {
  return [
    "--dist",
    options.dist,
    "--component",
    options.component,
    "--immutable",
    options.immutable,
    "--html-handling",
    options.htmlHandling,
    "--not-found-handling",
    options.notFoundHandling,
    "--base-path",
    options.basePath,
  ];
}
