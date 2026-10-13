import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // src/workers-shared is copied from cloudflare/workers-sdk; keep its formatting so a sync is a
    // clean diff.
    ignorePatterns: [
      "**/_generated/**",
      "**/routeTree.gen.ts",
      // Written by convex-hosting on every upload.
      "**/*.generated.ts",
      "packages/convex-hosting/src/workers-shared/**",
    ],
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
    ignorePatterns: [
      "**/dist",
      "**/_generated",
      "**/routeTree.gen.ts",
      // Written by convex-hosting on every upload.
      "**/*.generated.ts",
      "packages/convex-hosting/src/workers-shared/**",
    ],
    jsPlugins: [
      {
        name: "@convex-dev",
        specifier: "@convex-dev/eslint-plugin",
      },
    ],
    rules: {
      "typescript/no-floating-promises": "error",
      // The react plugin does not turn this on by itself.
      "react/rules-of-hooks": "error",
    },
    overrides: [
      {
        files: ["packages/convex-hosting/src/component/**/*.ts", "examples/*/convex/**/*.ts"],
        // The plugin's recommended rules. oxlint JS plugins get no type information, so
        // explicit-table-ids and no-filter-in-query use their syntax-only checks.
        rules: {
          "@convex-dev/no-old-registered-function-syntax": "error",
          "@convex-dev/require-args-validator": "error",
          "@convex-dev/explicit-table-ids": "error",
          "@convex-dev/no-filter-in-query": "warn",
          "@convex-dev/no-top-of-hour-crons": "warn",
          "@convex-dev/no-schema-import-cycle": "error",
          "@convex-dev/no-duplicate-indexes": "error",
          "@convex-dev/no-process-env": "error",
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
