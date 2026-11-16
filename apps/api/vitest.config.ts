import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Read D1 migrations in Node and hand them to the test runtime as a binding;
  // test/apply-migrations.ts applies them before tests run.
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // WORKER_TOKEN: test-only value for the /api/hub shared-secret check.
          bindings: { TEST_MIGRATIONS: migrations, WORKER_TOKEN: "test-worker-token" },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
