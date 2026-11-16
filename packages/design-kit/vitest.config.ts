import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Renderer tests launch Chromium; give them room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
