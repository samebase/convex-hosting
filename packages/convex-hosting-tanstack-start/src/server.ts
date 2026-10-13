// TanStack Start server entry for Convex HTTP actions. An app re-exports it from its own
// `src/server.ts`, which Vite builds as the server entry. Keep it self-contained: import only
// TanStack and React, never app code.

import type { Register } from "@tanstack/react-start";
import { createStartHandler, StartServer, type RequestHandler } from "@tanstack/react-start/server";
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

// `convex-hosting deploy` checks this tag in the rendered page. `convexSsr()` defines the ID at
// build time; it is empty for a build outside `deploy`.
const versionId = import.meta.env.CONVEX_HOSTING_VERSION_ID;
const versionMeta = versionId ? `<meta name="convex-hosting-version" content="${versionId}">` : "";

// `fetch(request, opts)` is TanStack's handler. `opts` takes the request context that the app
// registers. The declared type keeps the published declarations free of TanStack's internal
// router packages, which the inferred type names.
const server: { fetch: RequestHandler<Register> } = {
  fetch: createStartHandler((context) => {
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
        // React emits a doctype; TanStack's HTML helper adds its own. The version tag goes before
        // the first `</head>`; a page without one gets no tag.
        return html.replace(/^<!DOCTYPE html>/i, "").replace("</head>", `${versionMeta}</head>`);
      },
    });
  }),
};

export default server;
