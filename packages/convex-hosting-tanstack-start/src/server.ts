// TanStack Start server entry for Convex HTTP actions. An app re-exports it from its own
// `src/server.ts`, which Vite builds as the server entry. Keep it self-contained: import only
// TanStack and React, never app code.

import type { Register } from "@tanstack/react-start";
import {
  createStartHandler,
  defaultStreamHandler,
  type RequestHandler,
} from "@tanstack/react-start/server";

// Convex omits size, which TanStack uses when normalizing query-string URLs.
if (new URLSearchParams().size === undefined) {
  Object.defineProperty(URLSearchParams.prototype, "size", {
    configurable: true,
    get(this: URLSearchParams) {
      return Array.from(this).length;
    },
  });
}

// Convex has no queueMicrotask. TanStack calls it on the server: the ssr-query cache listener for a
// query that starts during the render rather than in a loader, and `attachRouterServerSsrUtils`
// when streamed hydration data, such as ssr-query's, finishes. Both look it up on each call.
if (typeof globalThis.queueMicrotask !== "function") {
  globalThis.queueMicrotask = (callback) => {
    void Promise.resolve().then(callback);
  };
}

// TanStack's own stream handler, as on every other host: React's Web Stream renderer, the
// document sent as it renders, each Suspense boundary and deferred loader value in a later chunk.
// Apps call only `fetch(request, { context })`. Start gives `context` to each route's `beforeLoad`
// and loader on the server as `serverContext`. `context` follows the app's `Register`: with a
// registered `requestContext`, such as the `convex-auth` entry's, it is required and has that type.
// The explicit annotation is what the declaration emits, so it names only public entries.
const server: { fetch: RequestHandler<Register> } = {
  fetch: createStartHandler(defaultStreamHandler),
};

export default server;
