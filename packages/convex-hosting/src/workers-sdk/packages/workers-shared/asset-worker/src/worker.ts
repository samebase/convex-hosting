// Ours, not synced. Upstream's worker.ts is the Cloudflare Worker entrypoint (KV, analytics,
// Sentry). handler.ts and utils/headers.ts import only these types from it.

import type { JaegerTracing } from "../../utils/types";

export type Env = {
  JAEGER: JaegerTracing;
};

export type GetByETagResult = {
  readableStream: ReadableStream;
  contentType: string | undefined;
  cacheStatus: "HIT" | "MISS";
};

/** The two callbacks that `handleRequest` and `canFetch` take, as upstream declares them. */
export default class AssetWorkerEntrypoint {
  unstable_exists(_pathname: string, _request?: Request): Promise<string | null> {
    throw new Error("Type-only declaration.");
  }

  unstable_getByETag(_eTag: string, _request?: Request): Promise<GetByETagResult> {
    throw new Error("Type-only declaration.");
  }
}
