import "./runtime.js";
import {
  httpActionGeneric,
  ROUTABLE_HTTP_METHODS,
  type HttpRouter,
  type PublicHttpAction,
} from "convex/server";
import { answer, type Answer } from "./answer.js";
import { ASSETS_FORMAT, type Assets } from "./manifest.js";

export type { Assets } from "./manifest.js";

/** What `routeAll` routes, each named as Cloudflare and Convex name it. */
export type RouteAllOptions = {
  /** The app's router, from `httpRouter()`. */
  http: HttpRouter;
  /** `assets` from `.convex-hosting/version.js`, which `convex-hosting deploy` writes. */
  assets: Assets;
  /**
   * The Worker script: the object with `fetch(request)` that the app's server entry exports, the
   * code that runs on a miss. Without it, the site is assets only.
   */
  worker?: { fetch(request: Request): Promise<Response> };
};

/**
 * The HTTP action that serves the site, for `routeAll`: it answers a request with an asset (another
 * method than GET or HEAD on an asset answers 405), else with what `worker` answers, else 404. As on
 * Cloudflare, the presence of a Worker script decides how `not_found_handling` applies: with
 * `worker`, it applies to navigations only and `worker` answers the other misses; without it, it
 * applies to every request.
 *
 * The assets are in the pushed code, so a request calls no function of the component, and
 * `routeAll` does not take it: a file costs this action and the download of its bytes, any other
 * answer this action alone.
 *
 * A page and a 404 answer `Cache-Control: no-store`. The deployment's Cloudflare front keeps that
 * for a path without an extension and replaces it with a four-hour browser `max-age` for a path
 * with one, so a browser that asks for a script before its upload ended keeps the 404; the deploy
 * order prevents that case, because no page refers to a file that is not uploaded yet.
 */
function serveSite({ assets, worker }: RouteAllOptions): PublicHttpAction {
  return httpActionGeneric(async (_ctx, request) => {
    if (assets.format !== ASSETS_FORMAT) {
      return notServed(
        500,
        `.convex-hosting/version.js has format ${assets.format}, and this release of ` +
          `@samebase/convex-hosting reads format ${ASSETS_FORMAT}. Deploy again.`,
      );
    }
    const { files } = assets;
    // A first install pushes before its upload; the deploy pushes again when the upload ends.
    if (files === null) {
      return notServed(404, `Version ${assets.versionId} of the site is not uploaded yet.`);
    }
    // The storage URLs name the deployment they were taken from.
    if (files.cloudUrl !== process.env.CONVEX_CLOUD_URL) {
      return notServed(
        404,
        `Version ${assets.versionId} of the site was uploaded to ${files.cloudUrl}, not to this ` +
          `deployment. Deploy to this deployment with convex-hosting deploy.`,
      );
    }

    const asset = await answer(files, request, worker !== undefined);
    if (asset !== null) return await withBody(asset);
    // `answer` answers every assets-only request itself, so this 404 only fails closed.
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
 * ```ts
 * routeAll({ http, assets, worker: server });
 * ```
 *
 * Returns the action, for the paths that a component's HTTP prefix would otherwise take: Convex
 * picks an exact route first, then the longest prefix, so an app whose session routes sit under a
 * component's prefix registers them with `http.route({ path, method, handler })`.
 */
export function routeAll(options: RouteAllOptions): PublicHttpAction {
  const action = serveSite(options);
  for (const method of ROUTABLE_HTTP_METHODS) {
    options.http.route({ pathPrefix: "/", method, handler: action });
  }
  return action;
}

/** The response of `asset`, with the stored file as its body when it has one. */
async function withBody(asset: Answer): Promise<Response> {
  if (asset.url === null)
    return new Response(null, { status: asset.status, headers: asset.headers });
  // An app cannot read a component's storage, so the body comes from the storage URL.
  let stored: Response;
  try {
    stored = await fetch(asset.url);
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
