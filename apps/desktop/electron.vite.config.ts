import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { wecraAliases, wecraStubs, wecraVendored } from "./wecra.vite.ts";

if (!wecraVendored())
  console.warn(
    "\n[studio] Wecra's editor is not vendored (src/renderer/vendor/wecra-editor): the post editor " +
      "shows how to add it. Run `node apps/desktop/scripts/vendor-wecra.mjs` with DesignerV2 next " +
      "to Studio (or --repo / WECRA_REPO). It is gitignored: Wecra is closed source.\n",
  );

/**
 * Dev only: the renderer (Vite on localhost) reaches the local API through this proxy,
 * same origin, so no CORS. The API port is whatever the running host wrote to
 * `~/Library/Application Support/Studio/host.json` (this app's supervisor or the AppKit
 * app it attached to); 8790 when there is none yet. The packaged app does the same through
 * its `studio://` protocol handler (src/main/protocol.ts).
 *
 * The proxy holds no secret (G1): the Electron main process adds the owner secret
 * (`X-Studio-Owner`) to the dev renderer's own `/api/` requests (src/main/app.ts, webRequest),
 * and the proxy forwards it with `Origin` and `Host` unchanged, so the API can still refuse a
 * web page that sends requests here (no secret, foreign Origin, rebound Host). The renderer
 * opened in a plain browser (`dev:renderer`) therefore gets 401 from owner-only routes.
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
    plugins: [wecraStubs(), react(), tailwindcss(), apiProxy()],
    resolve: {
      // `@renderer/…` is Studio's; `@/…` and `@shared/…` are Wecra's vendored editor (wecra.vite.ts).
      alias: [
        { find: /^@renderer\//, replacement: `${resolve(import.meta.dirname, "src/renderer")}/` },
        ...wecraAliases,
      ],
    },
    // Wecra's image decoding and document loading run in module workers.
    worker: { format: "es", plugins: () => [wecraStubs()] },
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
