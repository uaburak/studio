import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only secret values.
        bindings: {
          PUBLISHER_TOKEN: "test-publisher-token",
          TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
          MEDIA_URL_SECRET: "test-media-url-secret",
          PUBLIC_BASE_URL: "https://publisher.test",
        },
      },
    }),
  ],
});
