// Runs the same test suite inside workerd (the Cloudflare Workers runtime)
// to prove the package works there, not just in Node.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-11-13",
      },
    }),
  ],
});
