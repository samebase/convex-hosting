import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext(),
    // vinext emits its Worker entry, `{ fetch(request, env, ctx) }`, only in a Cloudflare build.
    // scripts/bundle-server.ts turns that entry into a module for Convex; nothing goes to Workers.
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      config: { main: "vinext/server/fetch-handler" },
    }),
  ],
});
