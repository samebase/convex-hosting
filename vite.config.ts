import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // The copied folders of src/workers-sdk keep their formatting, so a sync is a clean diff; the
    // files of ours in that tree (fixtures/shared, the TestCase declaration) are formatted.
    ignorePatterns: [
      "**/_generated/**",
      "**/routeTree.gen.ts",
      "packages/convex-hosting/src/workers-sdk/packages/**",
      "packages/convex-hosting/src/workers-sdk/fixtures/workers-shared-asset-config/test-cases/**",
      "packages/convex-hosting/src/workers-sdk/fixtures/workers-with-assets-only/**",
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
      "packages/convex-hosting/src/workers-sdk/packages/**",
      "packages/convex-hosting/src/workers-sdk/fixtures/workers-shared-asset-config/test-cases/**",
      "packages/convex-hosting/src/workers-sdk/fixtures/workers-with-assets-only/**",
    ],
    jsPlugins: [
      {
        name: "@convex-dev",
        specifier: "@convex-dev/eslint-plugin",
      },
    ],
    rules: {
      "typescript/no-floating-promises": "error",
      // tsc never reports a deprecated API (TS6387 is an editor suggestion); the editor does, so
      // the type-aware lint must.
      "typescript/no-deprecated": "error",
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
    projects: [
      {
        test: {
          name: "unit",
          environment: "edge-runtime",
          include: ["packages/*/src/**/*.test.ts", "examples/*/convex/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/src/workers-sdk/fixtures/**"],
        },
      },
      {
        // Cloudflare's integration fixtures, copied unchanged, each against an anonymous local
        // Convex deployment that the fixture's helper starts (see
        // src/workers-sdk/fixtures/shared/src/run-wrangler-long-lived.ts).
        test: {
          name: "fixtures",
          environment: "node",
          include: ["packages/convex-hosting/src/workers-sdk/fixtures/*/tests/**/*.test.ts"],
          hookTimeout: 300_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
