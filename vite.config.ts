import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["**/_generated/**", "**/routeTree.gen.ts"],
    printWidth: 100,
    proseWrap: "always",
  },
  lint: {
    options: {
      typeAware: true,
    },
    plugins: ["eslint", "typescript", "react"],
    env: {
      builtin: true,
      browser: true,
    },
    ignorePatterns: ["**/dist", "**/_generated", "**/routeTree.gen.ts"],
    jsPlugins: [
      {
        name: "@convex-dev",
        specifier: "@convex-dev/eslint-plugin",
      },
    ],
    rules: {
      "typescript/no-floating-promises": "error",
    },
    overrides: [
      {
        files: ["packages/convex-hosting/src/component/**/*.ts", "examples/*/convex/**/*.ts"],
        // The plugin's recommended rules without the ones that need TypeScript type information
        // (explicit-table-ids, no-filter-in-query, no-collect-in-query, no-process-env): oxlint
        // JS plugins get no type information, so those rules would run without effect.
        rules: {
          "@convex-dev/no-old-registered-function-syntax": "error",
          "@convex-dev/require-args-validator": "error",
          "@convex-dev/no-top-of-hour-crons": "warn",
          "@convex-dev/no-schema-import-cycle": "error",
          "@convex-dev/no-duplicate-indexes": "error",
        },
      },
    ],
  },
  test: {
    // The edge-runtime environment clears `process`; Vitest fork teardown then crashes while
    // restoring `process.exit`. Threads avoid that teardown path.
    pool: "threads",
    environment: "edge-runtime",
    include: ["packages/*/src/**/*.test.ts", "examples/*/convex/**/*.test.ts"],
  },
});
