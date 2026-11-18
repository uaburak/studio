import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { wecraAliases, wecraStubs } from "./wecra.vite.ts";

export default defineConfig({
  plugins: [wecraStubs(), react()],
  resolve: {
    alias: [
      { find: /^@renderer\//, replacement: `${resolve(import.meta.dirname, "src/renderer")}/` },
      ...wecraAliases,
    ],
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
        // Wecra's editor (vendored, gitignored) with its real engine, headless (jsdom, no WebGL).
        extends: true,
        test: {
          name: "engine",
          environment: "jsdom",
          include: ["test/engine/**/*.test.{ts,tsx}"],
          setupFiles: ["./test/engine/setup.ts"],
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
