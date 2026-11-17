import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@renderer": resolve(import.meta.dirname, "src/renderer") },
  },
  test: {
    env: { TZ: "Europe/Istanbul" },
    projects: [
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["test/renderer/**/*.test.{ts,tsx}"],
          setupFiles: ["./test/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "main",
          environment: "node",
          include: ["test/main/**/*.test.ts"],
        },
      },
    ],
  },
});
