import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../component/lib.js";
import {
  constructHeaders,
  constructRedirects,
} from "../workers-sdk/packages/workers-shared/utils/configuration/constructConfiguration.js";
import { parseHeaders } from "../workers-sdk/packages/workers-shared/utils/configuration/parseHeaders.js";
import { parseRedirects } from "../workers-sdk/packages/workers-shared/utils/configuration/parseRedirects.js";
import {
  HEADERS_FILENAME,
  MAX_ASSET_SIZE,
  REDIRECTS_FILENAME,
} from "../workers-sdk/packages/workers-shared/utils/constants.js";
import {
  createAssetsIgnoreFunction,
  getContentType,
  maybeGetFile,
  normalizeFilePath,
} from "../workers-sdk/packages/workers-shared/utils/helpers.js";

/**
 * Convex limits a document to 1 MiB. The version document holds the config next to two short
 * fields, and the encoding needs room too.
 */
const MAX_CONFIG_BYTES = 900 * 1024;

export type HandlingOptions = Required<Pick<Config, "html_handling" | "not_found_handling">>;

/** One file of the build: its URL path, its sha256 in hex, its content type, and its file on disk. */
export type DistEntry = {
  path: string;
  sha256: string;
  contentType: string | undefined;
  file: string;
};

/**
 * Reads the build in `dist` the way Wrangler reads an assets directory: every file that
 * `.assetsignore` does not ignore, and the config from `_headers` and `_redirects`, parsed by
 * Cloudflare's own parsers.
 */
export async function readDist(
  dist: string,
  handling: HandlingOptions,
  log: (message: string) => void,
): Promise<{ config: Config; entries: DistEntry[] }> {
  if (!existsSync(dist)) throw new Error(`The --dist folder ${dist} does not exist.`);
  const { assetsIgnoreFunction } = await createAssetsIgnoreFunction(dist);
  const entries: DistEntry[] = [];

  // The real paths of the folders that contain the one being walked. A link to one of them, for
  // example a link to `dist` itself, is a cycle and would otherwise be walked without end. A link to
  // any other folder, such as a sibling, is walked, so its files are uploaded under both paths.
  const ancestors = new Set([realpathSync(dist)]);
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      // A symbolic link counts as what it points to, as in Wrangler, which reads each path with
      // `stat`. A name that `readdir` lists and `stat` cannot find is a link to nothing.
      const stats = statSync(file, { throwIfNoEntry: false });
      if (stats === undefined) {
        log(`Skipped ${file}: a symbolic link to nothing.`);
        continue;
      }
      // `ignore` takes paths relative to `dist` with `/`, and a directory with a trailing `/`.
      const ignorePath = relative(dist, file).replaceAll("\\", "/");
      if (stats.isDirectory()) {
        // An ignored directory is not walked: gitignore rules cannot re-include a file in it.
        if (assetsIgnoreFunction(`${ignorePath}/`)) continue;
        const real = realpathSync(file);
        if (ancestors.has(real)) {
          log(`Skipped ${file}: a link to a folder that contains it.`);
          continue;
        }
        ancestors.add(real);
        walk(file);
        ancestors.delete(real);
      } else if (stats.isFile() && !assetsIgnoreFunction(ignorePath)) {
        const bytes = readFileSync(file);
        // Cloudflare's limit per asset, 25 MiB. The HTTP action that serves a file cannot answer
        // more than Convex's 100 MiB response limit anyway.
        if (bytes.byteLength > MAX_ASSET_SIZE) {
          throw new Error(
            `${file} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB. A file must stay at ` +
              "or below 25 MiB, Cloudflare's limit per asset.",
          );
        }
        entries.push({
          path: normalizeFilePath(relative(dist, file)),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          contentType: getContentType(file) ?? undefined,
          file,
        });
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
  const config: Config = {
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
  return { config, entries };
}
