import { Analytics } from "../workers-sdk/packages/workers-shared/asset-worker/src/analytics.js";
import {
  canFetch,
  handleRequest,
} from "../workers-sdk/packages/workers-shared/asset-worker/src/handler.js";
import { mockJaegerBinding } from "../workers-sdk/packages/workers-shared/utils/tracing.js";
import { manifestLookup, type AssetFiles, type ManifestHit } from "./manifest.js";

/** An answer of Cloudflare's handler, and the storage URL of its body, if it has one. */
export type Answer = { status: number; headers: Headers; url: string | null };

/**
 * Runs Cloudflare's asset handler for `request` against the version's files, or returns `null` when
 * no asset answers. `hasUserWorker` is Cloudflare's `has_user_worker`: whether the app has code that
 * answers a miss. With it, Cloudflare's router asks `canFetch` first, which keeps
 * `not_found_handling` for navigations only, and the app answers the other misses. Without it,
 * every request goes to `handleRequest`, so `not_found_handling` applies to all of them, and an
 * asset always answers.
 */
export async function answer(
  files: AssetFiles,
  request: Request,
  hasUserWorker: boolean,
): Promise<Answer | null> {
  const env = { JAEGER: mockJaegerBinding() };
  // `exists` returns the entry's ETag; `getByETag` gets the entry back for that ETag.
  const lookup = manifestLookup(files);
  const found = new Map<string, ManifestHit>();
  const exists = async (pathname: string) => {
    const hit = await lookup(pathname);
    if (hit === null) return null;
    found.set(hit.eTag, hit);
    return hit.eTag;
  };
  let body: ManifestHit | undefined;
  const getByETag = async (eTag: string) => {
    body = found.get(eTag);
    if (body === undefined) throw new Error(`No entry has the ETag ${eTag}.`);
    return {
      // `withBody` replaces this placeholder with the stored file.
      readableStream: new ReadableStream(),
      contentType: body.contentType,
      cacheStatus: "MISS" as const,
    };
  };

  if (hasUserWorker && !(await canFetch(request, env, files.config, exists))) return null;
  const response = await handleRequest(
    request,
    env,
    files.config,
    exists,
    getByETag,
    new Analytics(),
  );
  // It describes Cloudflare's cache, which does not exist here.
  response.headers.delete("CF-Cache-Status");
  // The deployment's Cloudflare front caches 404 answers on static paths.
  if (response.status === 404) response.headers.set("Cache-Control", "no-store");
  return {
    status: response.status,
    headers: response.headers,
    url: response.body !== null && body !== undefined ? body.url : null,
  };
}
