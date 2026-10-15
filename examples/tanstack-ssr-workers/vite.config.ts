import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    // Prerenders /about only. `prerender: { enabled: true }` would also prerender every static
    // route, and crawling would follow /about's links. The prerender runs through the Worker, and
    // the header tells src/server.ts to render without a session.
    tanstackStart({
      pages: [
        {
          path: "/about",
          prerender: { enabled: true, crawlLinks: false, headers: { "x-prerender": "1" } },
        },
      ],
    }),
    react(),
  ],
});
