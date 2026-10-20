import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { convexSsr } from "@samebase/convex-hosting-tanstack-start/vite";
import { convexAuth } from "@samebase/convex-auth-tanstack-start/vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    convexSsr(),
    convexAuth(),
    // Prerenders /about only. `prerender: { enabled: true }` would also prerender every static
    // route, and crawling would follow /about's links. The header marks the prerender's requests
    // for src/server.ts; a prerender renders without a visitor.
    tanstackStart({
      prerender: { headers: { "x-prerender": "1" } },
      pages: [{ path: "/about", prerender: { enabled: true, crawlLinks: false } }],
    }),
    react(),
  ],
});
