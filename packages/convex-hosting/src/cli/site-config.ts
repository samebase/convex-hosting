import type { Config } from "../component/lib.js";
import { normalizeConfiguration } from "../workers-sdk/packages/workers-shared/asset-worker/src/configuration.js";
import { AssetConfigSchema } from "../workers-sdk/packages/workers-shared/utils/types.js";

/**
 * The compatibility date of Cloudflare's handler. From 2025-04-01 on, Cloudflare applies
 * `not_found_handling` to a request with `Sec-Fetch-Mode: navigate` when a Worker exists.
 */
const COMPATIBILITY_DATE = "2025-04-01";

/** A version's config as Cloudflare's handler takes it, which the site carries. */
export function siteConfig(config: Config) {
  return normalizeConfiguration({
    ...AssetConfigSchema.parse(config),
    compatibility_date: COMPATIBILITY_DATE,
  });
}
