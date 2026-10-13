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
      getLiveVersion: FunctionReference<
        "query",
        "internal",
        {},
        { liveAt: number; versionId: string } | null,
        Name
      >;
      route: FunctionReference<
        "query",
        "internal",
        {
          exact: boolean;
          headers: Array<{ name: string; value: string }>;
          method: "GET" | "HEAD";
          url: string;
        },
        | { handled: false }
        | {
            body: { storageId: string; storageUrl: string } | null;
            handled: true;
            headers: Array<{ name: string; value: string }>;
            status: number;
          },
        Name
      >;
    };
  };
