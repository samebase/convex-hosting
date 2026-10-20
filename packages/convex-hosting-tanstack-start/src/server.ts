// TanStack Start server entry for Convex HTTP actions. An app re-exports it from its own
// `src/server.ts`, which Vite builds as the server entry. Keep it self-contained: import only
// TanStack and React, never app code. TanStack calls `queueMicrotask`, which Convex's runtime lacks;
// `@samebase/convex-hosting` defines it, and `convex/http.ts` imports that package first.

import type { Register } from "@tanstack/react-start";
import {
  createStartHandler,
  defaultStreamHandler,
  type RequestHandler,
} from "@tanstack/react-start/server";

// TanStack's own stream handler, as on every other host: React's Web Stream renderer, the
// document sent as it renders, each Suspense boundary and deferred loader value in a later chunk.
// Apps call only `fetch(request, { context })`. Start gives `context` to each route's `beforeLoad`
// and loader on the server as `serverContext`. `context` follows the app's `Register`: with a
// registered `requestContext`, such as `@samebase/convex-auth-tanstack-start`'s, it is required and
// has that type.
// The explicit annotation is what the declaration emits, so it names only public entries.
const server: { fetch: RequestHandler<Register> } = {
  fetch: createStartHandler(defaultStreamHandler),
};

export default server;
