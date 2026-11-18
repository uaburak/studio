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
          // TOKEN_ENCRYPTION_KEY: test-only token vault key (32+ characters).
          bindings: {
            TEST_MIGRATIONS: migrations,
            WORKER_TOKEN: "test-worker-token",
            TOKEN_ENCRYPTION_KEY: "test-vault-key-0123456789abcdef0123456789",
            // The desktop app's owner secret (the `local` principal); test/helpers.ts sends it.
            STUDIO_OWNER_SECRET: "test-owner-secret",
            // Route tests schedule Instagram posts without a cloud publisher; the local-mode
            // refusal itself is tested on preflightTargets (test/publishing.test.ts).
            STUDIO_ALLOW_PRIVATE_MEDIA_URLS: "1",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
