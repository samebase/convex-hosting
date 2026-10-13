/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      markLive: FunctionReference<
        "mutation",
        "internal",
        { expectedNewestLiveAt: number | null; versionId: string },
        null,
        Name
      >;
      route: FunctionReference<
        "query",
        "internal",
        {
          headers: Record<string, string>;
          method: string;
          url: string;
          versionId: string;
        },
        {
          asset: null | {
            bodyUrl: string | null;
            headers: Array<{ name: string; value: string }>;
            status: number;
          };
          newestLiveAt: number | null;
          state: "uploading" | "ready" | "live" | null;
        },
        Name
      >;
    };
  };
