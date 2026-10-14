// TanStack Start server entry for Convex HTTP actions. An app re-exports it from its own
// `src/server.ts`, which Vite builds as the server entry. Keep it self-contained: import only
// TanStack and React, never app code.

import { createStartHandler, StartServer } from "@tanstack/react-start/server";
import { renderSsrHtmlResponse } from "@tanstack/react-router/ssr/server";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";

// Convex omits size, which TanStack uses when normalizing query-string URLs.
if (new URLSearchParams().size === undefined) {
  Object.defineProperty(URLSearchParams.prototype, "size", {
    configurable: true,
    get(this: URLSearchParams) {
      return Array.from(this).length;
    },
  });
}

// Apps call only `fetch(request, { context })`. Start gives `context` to each route's `beforeLoad`
// and loader on the server as `serverContext`. The inferred handler type names TanStack's internal
// router packages, which the published declarations cannot reference, and `<unknown>` keeps it off
// `Register`, where the `convex-auth` entry's `requestContext` would make `context` required.
const server: {
  fetch: (
    request: Request,
    opts?: { context?: Record<string, unknown> },
  ) => Response | Promise<Response>;
} = {
  fetch: createStartHandler<unknown>((context) => {
    const { router, responseHeaders, request } = context;
    return renderSsrHtmlResponse({
      router,
      responseHeaders,
      render: async () => {
        // Await Suspense with React's Web Stream renderer. TanStack's stream
        // handler also imports node:stream, which Convex cannot bundle.
        const stream = await renderToReadableStream(createElement(StartServer, { router }), {
          signal: request.signal,
          ...(router.options.ssr?.nonce === undefined ? {} : { nonce: router.options.ssr.nonce }),
        });
        await stream.allReady;
        const html = await new Response(stream).text();
        // React emits a doctype; TanStack's HTML helper adds its own.
        return html.replace(/^<!DOCTYPE html>/i, "");
      },
    });
  }),
};

export default server;
