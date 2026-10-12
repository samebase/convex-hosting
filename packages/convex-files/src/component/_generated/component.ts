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
      cleanupUnregistered: FunctionReference<
        "mutation",
        "internal",
        { before: number; cursor?: string; limit?: number },
        {
          continueCursor: string | null;
          deleted: number;
          isDone: boolean;
          scanned: number;
        },
        Name
      >;
      generateUploadUrl: FunctionReference<
        "mutation",
        "internal",
        {},
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { fileId: string },
        {
          _creationTime: number;
          _id: string;
          metadata: {
            _creationTime: number;
            _id: string;
            contentType?: string;
            sha256: string;
            size: number;
          } | null;
          path: string;
          storageId: string;
          url: string | null;
        } | null,
        Name
      >;
      getByPath: FunctionReference<
        "query",
        "internal",
        { path: string },
        {
          _creationTime: number;
          _id: string;
          metadata: {
            _creationTime: number;
            _id: string;
            contentType?: string;
            sha256: string;
            size: number;
          } | null;
          path: string;
          storageId: string;
          url: string | null;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          prefix: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            path: string;
            storageId: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      register: FunctionReference<
        "mutation",
        "internal",
        { path: string; storageId: string },
        string,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { fileId: string },
        null,
        Name
      >;
      removeUnregistered: FunctionReference<
        "mutation",
        "internal",
        { storageId: string },
        "deleted" | "registered" | "missing",
        Name
      >;
      rename: FunctionReference<
        "mutation",
        "internal",
        { fileId: string; path: string },
        null,
        Name
      >;
    };
  };
