// Writes a synthetic built site to `<dir>/site`: an index page, a 404 page, and `count` scripts of
// about 2 KB, named the way Vite names chunks. Every file has its own bytes, so every file is stored
// once. The path of a script in the middle goes to `<dir>/paths.json`, outside the site.
//   node site.ts <count> <dir>
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeSite(count: number, dir: string) {
  const site = join(dir, "site");
  rmSync(site, { recursive: true, force: true });
  mkdirSync(join(site, "assets"), { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = `export const chunk${i} = ${JSON.stringify("x".repeat(2000))}; // chunk ${i}\n`;
    const hash = createHash("sha256").update(body).digest("base64url").slice(0, 8);
    const name = `/assets/chunk-${i}-${hash}.js`;
    writeFileSync(join(site, name), body);
    names.push(name);
  }
  const page = (title: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<script type="module" src="${names[0]}"></script></head><body><h1>${title}</h1></body></html>\n`;
  writeFileSync(join(site, "index.html"), page("Benchmark site"));
  writeFileSync(join(site, "404.html"), page("Not found"));
  const paths = { asset: names[Math.floor(count / 2)] };
  writeFileSync(join(dir, "paths.json"), `${JSON.stringify(paths)}\n`);
  return paths;
}

if (import.meta.main) {
  const count = Number(process.argv[2]);
  const dir = process.argv[3];
  if (!Number.isInteger(count) || count < 1 || dir === undefined) {
    throw new Error("Usage: node site.ts <count> <dir>");
  }
  writeSite(count, dir);
  console.log(`Wrote ${count} scripts, index.html and 404.html to ${join(dir, "site")}.`);
}
