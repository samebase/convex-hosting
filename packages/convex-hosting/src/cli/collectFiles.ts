import { readdirSync } from "fs";
import { extname, join, relative } from "path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
};

// Cloudflare and Netlify read these files at the root of the build output as hosting rules and
// never serve them. This package does not apply them, so it does not upload them either.
const HOSTING_RULE_FILES = new Set(["/_headers", "/_redirects"]);

export type CollectedFile = { path: string; localPath: string; contentType: string };

export function collectFiles(distDir: string): {
  files: CollectedFile[];
  skipped: string[];
} {
  const files: CollectedFile[] = [];
  const skipped: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const localPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(localPath);
      } else if (entry.isFile()) {
        const path = "/" + relative(distDir, localPath).replace(/\\/g, "/");
        if (HOSTING_RULE_FILES.has(path)) {
          skipped.push(path);
          continue;
        }
        files.push({
          path,
          localPath,
          contentType: MIME_TYPES[extname(localPath).toLowerCase()] || "application/octet-stream",
        });
      }
    }
  };
  visit(distDir);
  return { files, skipped };
}
