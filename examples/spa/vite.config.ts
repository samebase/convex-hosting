import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  base: process.env.CONVEX_HOSTING_BASE_PATH ?? "/",
  plugins: [react()],
  resolve: {
    conditions: ["@convex-dev/component-source"],
  },
});
