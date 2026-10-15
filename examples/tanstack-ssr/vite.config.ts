import { defineConfig, loadEnv } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { convexSsr } from "@samebase/convex-hosting-tanstack-start/vite";

// The dev server sends the `/auth` routes of convex/http.ts to the deployment, so the session
// cookies belong to the dev origin. A cloud deployment needs its own Host, and the routes trust a
// request whose Origin matches its Host, so a request from the dev origin gets the deployment's
// origin; a request from another origin keeps its Origin and gets 403.
const { VITE_CONVEX_SITE_URL: siteUrl } = loadEnv(
  "development",
  import.meta.dirname,
  "VITE_CONVEX_SITE_URL",
);

export default defineConfig({
  root: import.meta.dirname,
  server: {
    proxy: {
      "/auth/": {
        target: siteUrl,
        changeOrigin: true,
        configure: (proxy) =>
          proxy.on("proxyReq", (proxyRequest, request) => {
            if (request.headers.origin === `http://${request.headers.host}`) {
              proxyRequest.setHeader("origin", new URL(siteUrl).origin);
            }
          }),
      },
    },
  },
  plugins: [
    convexSsr(),
    // Prerenders /about only. `prerender: { enabled: true }` would also prerender every static
    // route, and crawling would follow /about's links.
    tanstackStart({ pages: [{ path: "/about", prerender: { enabled: true, crawlLinks: false } }] }),
    react(),
  ],
});
