import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

/**
 * Answers `request` with the asset of version `versionId` that Cloudflare's asset handler picks.
 *
 * Returns `null` when no asset matches, so the app continues (a static site answers 404, a
 * server-rendered site renders the page). A version that does not exist or is still uploading
 * answers 404, so a half-installed site does not render pages without their files.
 */
export async function serveAsset(
  ctx: Pick<GenericActionCtx<GenericDataModel>, "runQuery">,
  component: ComponentApi,
  request: Request,
  versionId: string,
): Promise<Response | null> {
  const { state, asset } = await ctx.runQuery(component.lib.route, {
    versionId,
    method: request.method,
    url: request.url,
    headers: handlerHeaders(request.headers),
  });
  if (state !== "ready") {
    const problem = state === null ? "does not exist" : "is still uploading";
    return new Response(`Version ${versionId} of the site ${problem}.`, {
      status: 404,
      headers: NO_STORE,
    });
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
