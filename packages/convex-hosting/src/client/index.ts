import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

/**
 * Answers `request` with the file of version `versionId`, else with the page that `render`
 * returns, else 404. `render` is the Worker script: the code that runs on a miss, with the request
 * in its closure. As on Cloudflare, the presence of code decides how `not_found_handling` applies:
 * with `render`, it applies to navigations only and `render` answers the other misses; without
 * `render`, the site is files only, so it applies to every request.
 *
 * A page and a 404 answer `Cache-Control: no-store`. The deployment's Cloudflare front keeps that
 * for a path without an extension and replaces it with a four-hour browser `max-age` for a path
 * with one, so a browser that asks for a script before its upload ended keeps the 404; the deploy
 * order prevents that case, because no page refers to a file that is not uploaded yet.
 */
export async function serveSite(
  ctx: Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation">,
  component: ComponentApi,
  request: Request,
  versionId: string,
  render?: () => Promise<Response>,
): Promise<Response> {
  const asset = await answer(ctx, component, request, versionId, render !== undefined);
  if (asset !== null) return asset;
  // `route` answers every files-only request itself, so this 404 only fails closed.
  if (render === undefined) return new Response(null, { status: 404, headers: NO_STORE });
  const page = await render();
  const headers = new Headers(page.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(page.body, { status: page.status, headers });
}

/**
 * Answers `request` with the asset of version `versionId` that Cloudflare's asset handler picks,
 * or returns `null` when no asset matches. `hasUserWorker` is Cloudflare's `has_user_worker`.
 *
 * A version that does not exist, is still uploading, or is being deleted answers 404, so a
 * half-installed site does not render pages without their files. The first request for a `ready`
 * version marks it live, which deletes the versions that were live before it; a version older than
 * the live one is never marked.
 */
async function answer(
  ctx: Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation">,
  component: ComponentApi,
  request: Request,
  versionId: string,
  hasUserWorker: boolean,
): Promise<Response | null> {
  const { state, asset } = await ctx.runQuery(component.lib.route, {
    versionId,
    method: request.method,
    url: request.url,
    headers: handlerHeaders(request.headers),
    hasUserWorker,
  });
  if (state === null || state === "uploading" || state === "deleting") {
    const problem =
      state === null
        ? "does not exist"
        : state === "uploading"
          ? "is still uploading"
          : "is being deleted";
    return new Response(`Version ${versionId} of the site ${problem}.`, {
      status: 404,
      headers: NO_STORE,
    });
  }
  // Only the pushed code knows which version the deployment runs, so its first request reports it.
  if (state === "ready") {
    await ctx.runMutation(component.lib.markLive, { versionId });
  }
  if (asset === null) return null;

  const headers = new Headers();
  for (const { name, value } of asset.headers) headers.append(name, value);
  if (asset.bodyUrl === null) return new Response(null, { status: asset.status, headers });

  // An app cannot read a component's storage, so the body comes from the storage URL.
  let stored: Response;
  try {
    stored = await fetch(asset.bodyUrl);
  } catch {
    return badGateway();
  }
  // A deploy deleted the file between the query and the fetch.
  if (stored.status === 404) return new Response(null, { status: 404, headers: NO_STORE });
  if (!stored.ok) return badGateway();
  return new Response(stored.body, { status: asset.status, headers });
}

/**
 * The request headers that Cloudflare's handler reads. It reads only the presence of
 * `Authorization` and `Range`, so their values (a credential, for one) stay out of the query.
 */
function handlerHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of ["if-none-match", "sec-fetch-mode"]) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  for (const name of ["authorization", "range"]) {
    if (headers.has(name)) picked[name] = "";
  }
  return picked;
}

/**
 * For the answers that no uploaded file gives. The deployment's Cloudflare front caches 404 answers
 * on static paths, so without it a script requested seconds before its upload ended would stay
 * missing for hours (the 0.3.2 incident).
 */
const NO_STORE = { "Cache-Control": "no-store" };

function badGateway() {
  return new Response(null, { status: 502, headers: NO_STORE });
}
