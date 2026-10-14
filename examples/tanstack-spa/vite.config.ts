import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    // SPA mode: the build prerenders only the root route, as the shell, into
    // dist/client/index.html, the file that the single-page-application fallback serves.
    tanstackStart({ spa: { prerender: { outputPath: "/index" } } }),
    react(),
  ],
});
