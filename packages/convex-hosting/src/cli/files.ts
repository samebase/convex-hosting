import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Manifest } from "../component/lib.js";
import {
  constructHeaders,
  constructRedirects,
} from "../workers-shared/utils/configuration/constructConfiguration.js";
import { parseHeaders } from "../workers-shared/utils/configuration/parseHeaders.js";
import { parseRedirects } from "../workers-shared/utils/configuration/parseRedirects.js";
import { HEADERS_FILENAME, REDIRECTS_FILENAME } from "../workers-shared/utils/constants.js";
import {
  createAssetsIgnoreFunction,
  getContentType,
  maybeGetFile,
  normalizeFilePath,
} from "../workers-shared/utils/helpers.js";

/**
 * Convex limits a document to 1 MiB. The version document holds the config next to two short
 * fields, and the encoding needs room too.
 */
const MAX_CONFIG_BYTES = 900 * 1024;

export type HandlingOptions = Required<
  Pick<Manifest["config"], "html_handling" | "not_found_handling">
>;

/**
 * Reads the build in `dist` the way Wrangler reads an assets directory: every file that
 * `.assetsignore` does not ignore, and the config from `_headers` and `_redirects`, parsed by
 * Cloudflare's own parsers. Returns the manifest and each path's file on disk.
 */
export async function readDist(
  dist: string,
  handling: HandlingOptions,
  log: (message: string) => void,
): Promise<{ manifest: Manifest; files: Map<string, string> }> {
  const { assetsIgnoreFunction } = await createAssetsIgnoreFunction(dist);
  const entries: Manifest["entries"] = [];
  const files = new Map<string, string>();

  const walk = (directory: string) => {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, dirent.name);
      // `ignore` takes paths relative to `dist` with `/`, and a directory with a trailing `/`.
      const ignorePath = relative(dist, file).replaceAll("\\", "/");
      if (dirent.isDirectory()) {
        // An ignored directory is not walked: gitignore rules cannot re-include a file in it.
        if (!assetsIgnoreFunction(`${ignorePath}/`)) walk(file);
      } else if (dirent.isFile() && !assetsIgnoreFunction(ignorePath)) {
        const bytes = readFileSync(file);
        const path = normalizeFilePath(relative(dist, file));
        entries.push({
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          contentType: getContentType(file) ?? undefined,
        });
        files.set(path, file);
      }
    }
  };
  walk(dist);

  const logger = {
    debug: () => {},
    log,
    info: log,
    warn: log,
    error: (error: Error) => log(error.message),
  };
  const redirectsFile = join(dist, REDIRECTS_FILENAME);
  const redirects = maybeGetFile(redirectsFile);
  const headersFile = join(dist, HEADERS_FILENAME);
  const headers = maybeGetFile(headersFile);
  const config: Manifest["config"] = {
    html_handling: handling.html_handling,
    not_found_handling: handling.not_found_handling,
    ...(redirects === undefined
      ? {}
      : constructRedirects({
          redirects: parseRedirects(redirects, { htmlHandling: handling.html_handling }),
          redirectsFile,
          logger,
        })),
    ...(headers === undefined
      ? {}
      : constructHeaders({ headers: parseHeaders(headers), headersFile, logger })),
  };

  const configBytes = Buffer.byteLength(JSON.stringify(config));
  if (configBytes > MAX_CONFIG_BYTES) {
    const largest =
      Buffer.byteLength(JSON.stringify(config.redirects ?? {})) >=
      Buffer.byteLength(JSON.stringify(config.headers ?? {}))
        ? redirectsFile
        : headersFile;
    throw new Error(
      `The rules in ${largest} make the version's config ${Math.ceil(configBytes / 1024)} KiB. ` +
        "It must stay at or below 900 KiB, because Convex limits a document to 1 MiB.",
    );
  }
  return { manifest: { config, entries }, files };
}
