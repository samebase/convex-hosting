import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MAX_ASSET_SIZE } from "../workers-shared/utils/constants.js";
import { createAssetsIgnoreFunction, normalizeFilePath } from "../workers-shared/utils/helpers.js";

export const MAX_FILES = 4000;
export const MAX_PATH_BYTES = 1024;

/** A file of the build output. `path` is the decoded URL path, starting with `/`. */
export type LocalFile = { path: string; localPath: string; size: number };

/**
 * The files to upload from `dist`, sorted by path. `.assetsignore` (gitignore syntax) applies, as
 * on Cloudflare: its own file and the root `_headers` and `_redirects` files are never uploaded.
 * Dot files and dot directories are skipped too, except `.well-known`. That also skips
 * `.convex-hosting/version.json`.
 */
export async function collectFiles(dist: string): Promise<LocalFile[]> {
  const { assetsIgnoreFunction } = await createAssetsIgnoreFunction(dist);
  const files: LocalFile[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(".") && name !== ".well-known") continue;
      const localPath = join(directory, name);
      const stats = statSync(localPath);
      if (stats.isDirectory()) {
        visit(localPath);
      } else if (stats.isFile()) {
        const path = normalizeFilePath(relative(dist, localPath));
        if (!assetsIgnoreFunction(path.slice(1))) files.push({ path, localPath, size: stats.size });
      }
    }
  };
  visit(dist);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  checkUploadLimits(dist, files);
  return files;
}

export function checkUploadLimits(dist: string, files: Pick<LocalFile, "path" | "size">[]): void {
  if (files.length === 0) throw new Error(`${dist} has no files to upload.`);
  if (files.length > MAX_FILES) {
    throw new Error(`${dist} has ${files.length} files. A version holds at most ${MAX_FILES}.`);
  }
  for (const { path, size } of files) {
    const pathBytes = Buffer.byteLength(path);
    if (pathBytes > MAX_PATH_BYTES) {
      throw new Error(`${path} is ${pathBytes} bytes long. A path is at most ${MAX_PATH_BYTES}.`);
    }
    if (size > MAX_ASSET_SIZE) {
      throw new Error(`${path} is ${size} bytes. A file is at most 25 MiB (${MAX_ASSET_SIZE}).`);
    }
  }
}
