import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Dev only: the renderer (Vite on localhost) reaches the local API through this proxy,
 * same origin, so no CORS. The API port is whatever the running host wrote to
 * `~/Library/Application Support/Studio/host.json` (this app's supervisor or the AppKit
 * app it attached to); 8790 when there is none yet. The packaged app does the same through
 * its `studio://` protocol handler (src/main/protocol.ts).
 */
function apiPort(): number {
  try {
    const file = join(homedir(), "Library/Application Support/Studio/host.json");
    const host = JSON.parse(readFileSync(file, "utf8")) as { apiPort?: number };
    if (typeof host.apiPort === "number") return host.apiPort;
  } catch {
    // no host yet
  }
  return 8790;
}

/** `/api/*` → http://127.0.0.1:<current port>/api/* (HTTP only; WebSockets connect directly). */
function apiProxy(): Plugin {
  return {
    name: "studio-api-proxy",
    configureServer(server) {
      server.middlewares.use("/api", (req, res) => {
        const headers = { ...req.headers };
        delete headers.origin;
        delete headers.referer;
        const upstream = request(
          {
            host: "127.0.0.1",
            port: apiPort(),
            method: req.method,
            path: `/api${req.url ?? ""}`,
            headers,
          },
          (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { code: "unavailable", message: "Studio sunucusu hazır değil." },
            }),
          );
        });
        req.pipe(upstream);
      });
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        // Sandboxed preloads must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react(), tailwindcss(), apiProxy()],
    resolve: {
      alias: { "@renderer": resolve(import.meta.dirname, "src/renderer") },
    },
    server: {
      host: "127.0.0.1",
      port: 5183,
      strictPort: false,
    },
    build: {
      outDir: resolve(import.meta.dirname, "out/renderer"),
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, "src/renderer/index.html") },
      },
    },
  },
});
