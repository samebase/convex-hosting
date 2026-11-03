import "./runtime.js";
import {
  httpActionGeneric,
  ROUTABLE_HTTP_METHODS,
  type HttpRouter,
  type PublicHttpAction,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { Analytics } from "../workers-sdk/packages/workers-shared/asset-worker/src/analytics.js";
import {
  canFetch,
  handleRequest,
} from "../workers-sdk/packages/workers-shared/asset-worker/src/handler.js";
import { mockJaegerBinding } from "../workers-sdk/packages/workers-shared/utils/tracing.js";
import {
  lookup,
  MARK_HEADER,
  SITE_FORMAT,
  storageUrl,
  type ManifestHit,
  type Site,
  type SiteFiles,
} from "./manifest.js";

export type { Site } from "./manifest.js";

/**
 * The HTTP action that serves the site, for `routeAll`: it answers a request with the file of the
 * site (another method than GET or HEAD on a file answers 405), else with what `worker` answers,
 * else 404. `worker` is the Worker script, the object with `fetch(request)` that the app's server
 * entry exports: the code that runs on a miss. As on Cloudflare, the presence of code decides how
 * `not_found_handling` applies: with `worker`, it applies to navigations only and `worker` answers
 * the other misses; without it, the site is files only, so it applies to every request.
 *
 * The site's files are in the pushed code, so a request calls no function of the component: a file
 * costs this action and the download of its bytes, any other answer this action alone.
 *
 * A page and a 404 answer `Cache-Control: no-store`. The deployment's Cloudflare front keeps that
 * for a path without an extension and replaces it with a four-hour browser `max-age` for a path
 * with one, so a browser that asks for a script before its upload ended keeps the 404; the deploy
 * order prevents that case, because no page refers to a file that is not uploaded yet.
 */
function serveSite(
  component: ComponentApi,
  site: Site,
  worker?: { fetch(request: Request): Promise<Response> },
): PublicHttpAction {
  return httpActionGeneric(async (ctx, request) => {
    if (site.format !== SITE_FORMAT) {
      return notServed(
        500,
        `.convex-hosting/version.js has format ${site.format}, and this release of ` +
          `@samebase/convex-hosting reads format ${SITE_FORMAT}. Deploy again.`,
      );
    }
    if (request.headers.get(MARK_HEADER) === site.markToken) {
      const result = await ctx.runMutation(component.lib.markLive, { versionId: site.versionId });
      return Response.json({ versionId: site.versionId, result }, { headers: NO_STORE });
    }
    const { files } = site;
    // A first install pushes before its upload; the deploy pushes again when the upload ends.
    if (files === null) {
      return notServed(404, `Version ${site.versionId} of the site is not uploaded yet.`);
    }
    // The storage URLs name the deployment they were taken from.
    if (files.cloudUrl !== process.env.CONVEX_CLOUD_URL) {
      return notServed(
        404,
        `Version ${site.versionId} of the site was uploaded to ${files.cloudUrl}, not to this ` +
          `deployment. Deploy to this deployment with convex-hosting deploy.`,
      );
    }

    const asset = await answer(files, request, worker !== undefined);
    if (asset !== null) return await withBody(files, asset);
    // `answer` answers every files-only request itself, so this 404 only fails closed.
    if (worker === undefined) return new Response(null, { status: 404, headers: NO_STORE });
    const page = await worker.fetch(request);
    const headers = new Headers(page.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(page.body, { status: page.status, headers });
  });
}

/**
 * Routes the site on the app's router: `serveSite`'s action for every method Convex routes, at
 * every path, as every request reaches a Cloudflare Worker with static assets. Convex answers HEAD
 * through GET.
 *
 * Returns the action, for the paths that a component's HTTP prefix would otherwise take: Convex
 * picks an exact route first, then the longest prefix, so an app whose session routes sit under a
 * component's prefix registers them with `http.route({ path, method, handler })`.
 */
export function routeAll(
  http: HttpRouter,
  component: ComponentApi,
  site: Site,
  worker?: { fetch(request: Request): Promise<Response> },
): PublicHttpAction {
  const action = serveSite(component, site, worker);
  for (const method of ROUTABLE_HTTP_METHODS) {
    http.route({ pathPrefix: "/", method, handler: action });
  }
  return action;
}

/** An answer of Cloudflare's handler, and the stored file of its body, if it has one. */
export type Asset = { status: number; headers: Headers; file: number | null };

/**
 * Runs Cloudflare's asset handler for `request` against the site's files, or returns `null` when no
 * asset answers. `hasUserWorker` is Cloudflare's `has_user_worker`: whether the app has code that
 * answers a miss. With it, Cloudflare's router asks `canFetch` first, which keeps
 * `not_found_handling` for navigations only, and the app answers the other misses. Without it,
 * every request goes to `handleRequest`, so `not_found_handling` applies to all of them, and an
 * asset always answers.
 */
export async function answer(
  files: SiteFiles,
  request: Request,
  hasUserWorker: boolean,
): Promise<Asset | null> {
  const env = { JAEGER: mockJaegerBinding() };
  // `exists` returns an ETag; `getByETag` gets the entry back for that ETag. The ETag is the content
  // hash and a short hash of the content type, so identical bytes under two types stay distinct.
  const found = new Map<string, ManifestHit>();
  const exists = async (pathname: string) => {
    const hit = await lookup(files, pathname);
    if (hit === null) return null;
    const eTag = hit.contentHash + (await shortHash(hit.contentType ?? ""));
    found.set(eTag, hit);
    return eTag;
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
    file: response.body !== null && body !== undefined ? body.file : null,
  };
}

/** The response of `asset`, with the stored file as its body when it has one. */
async function withBody(files: SiteFiles, asset: Asset): Promise<Response> {
  if (asset.file === null)
    return new Response(null, { status: asset.status, headers: asset.headers });
  // An app cannot read a component's storage, so the body comes from the storage URL.
  let stored: Response;
  try {
    stored = await fetch(storageUrl(files.storage, asset.file));
  } catch {
    return new Response(null, { status: 502, headers: NO_STORE });
  }
  // A deploy deleted the file: this code was replaced, and a later version's mark deleted it.
  if (stored.status === 404) return new Response(null, { status: 404, headers: NO_STORE });
  if (!stored.ok) return new Response(null, { status: 502, headers: NO_STORE });
  return new Response(stored.body, { status: asset.status, headers: asset.headers });
}

/**
 * For the answers that no uploaded file gives. The deployment's Cloudflare front caches 404 answers
 * on static paths, so without it a script requested seconds before its upload ended would stay
 * missing for hours (the 0.3.2 incident).
 */
const NO_STORE = { "Cache-Control": "no-store" };

/** A site that cannot serve this request, named in the body. */
function notServed(status: number, message: string) {
  return new Response(message, { status, headers: NO_STORE });
}

/** The first 8 hex digits of the SHA-256 of `text`. */
async function shortHash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest, 0, 4), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
