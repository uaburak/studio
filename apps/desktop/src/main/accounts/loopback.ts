// One-shot HTTP listener on the loopback interface that catches an OAuth redirect
// (`http://localhost:8793/meta/callback?code=…`): the browser gets a short Turkish page, the app
// gets the full callback URL. Port of the AppKit app's OAuthLoopbackServer.
//
// Facebook's token flow (no App Secret) puts the token in the URL fragment, which browsers never
// send; a callback without a query gets a tiny page that moves the fragment into the query and
// reloads, then that request is caught.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { OAUTH_HOST, OAUTH_PORT } from "../../shared/accounts-ipc.ts";

export class LoopbackError extends Error {
  constructor(
    readonly reason: "port_busy" | "timed_out" | "cancelled",
    port: number,
  ) {
    super(
      reason === "port_busy"
        ? `Giriş dönüşü için ${port} portu açılamadı (başka bir uygulama kullanıyor olabilir).`
        : reason === "timed_out"
          ? "Tarayıcıdaki giriş 5 dakika içinde tamamlanmadı."
          : "Giriş iptal edildi.",
    );
    this.name = "LoopbackError";
  }
}

export interface LoopbackOptions {
  /** Default 8793 (registered in the owner's apps). Tests pass 0 for a free port. */
  port?: number;
  /** Loopback addresses to bind; `localhost` may resolve to either, so both by default. */
  hosts?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called once listening, with the port (open the browser here). */
  onReady?: (port: number) => void;
  /** Delay before the listener closes, so the answer page reaches the browser. */
  closeDelayMs?: number;
}

export function page(message: string, script?: string): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Studio</title>
<style>body{font:15px -apple-system,system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#fff;color:#101010}
@media(prefers-color-scheme:dark){body{background:#161617;color:#f2f2f3}}p{max-width:420px;text-align:center;line-height:1.5}</style>
</head><body><p>${message}</p>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

const FRAGMENT_SCRIPT =
  "if(location.hash.length>1){location.replace(location.pathname+'?'+location.hash.substring(1));}else{document.body.innerHTML='<p>Giriş yanıtı boş geldi. Studio’ya dönüp yeniden deneyin.</p>';}";

/** Start listening, then call `onReady`; resolves with the callback URL (query included). */
export function waitForCallback(path: string, options: LoopbackOptions = {}): Promise<URL> {
  const port = options.port ?? OAUTH_PORT;
  const hosts = options.hosts ?? ["127.0.0.1", "::1"];
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const closeDelayMs = options.closeDelayMs ?? 500;

  return new Promise<URL>((resolve, reject) => {
    const servers: Server[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let boundPort = port;

    const closeAll = (delay: number) => {
      const close = () => {
        for (const server of servers) {
          server.close();
          server.closeAllConnections?.();
        }
      };
      if (delay > 0) setTimeout(close, delay).unref?.();
      else close();
    };

    const finish = (result: { url: URL } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if ("url" in result) {
        closeAll(closeDelayMs);
        resolve(result.url);
      } else {
        closeAll(0);
        reject(result.error);
      }
    };

    const onAbort = () => finish({ error: new LoopbackError("cancelled", boundPort) });

    const handle = (req: IncomingMessage, res: ServerResponse) => {
      const send = (status: number, body: string) => {
        res.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          connection: "close",
        });
        res.end(body);
      };
      if (req.method !== "GET") return send(405, "");
      const target = req.url ?? "/";
      const queryIndex = target.indexOf("?");
      const requestPath = queryIndex === -1 ? target : target.slice(0, queryIndex);
      if (requestPath !== path) return send(404, "");
      if (queryIndex === -1) {
        // Implicit flow: the token is in the fragment; move it into the query.
        return send(200, page("Giriş tamamlanıyor…", FRAGMENT_SCRIPT));
      }
      send(200, page("Giriş Studio’ya iletildi. Bu sekmeyi kapatıp Studio’ya dönebilirsiniz."));
      finish({ url: new URL(`http://${OAUTH_HOST}:${boundPort}${target}`) });
    };

    if (options.signal?.aborted) {
      reject(new LoopbackError("cancelled", port));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let pending = hosts.length;
    let listening = 0;
    const done = () => {
      pending -= 1;
      if (pending > 0 || settled) return;
      if (listening === 0) {
        finish({ error: new LoopbackError("port_busy", port) });
        return;
      }
      timer = setTimeout(
        () => finish({ error: new LoopbackError("timed_out", boundPort) }),
        timeoutMs,
      );
      timer.unref?.();
      options.onReady?.(boundPort);
    };

    // The first host decides the port (tests: an ephemeral one); the others share it.
    const listenOn = (index: number) => {
      const host = hosts[index];
      if (host === undefined) return;
      const server = createServer(handle);
      servers.push(server);
      server.once("error", (error: NodeJS.ErrnoException) => {
        server.close();
        // The first (IPv4) address must work; another may be missing (IPv6 off).
        if (index === 0 || error.code === "EADDRINUSE") {
          finish({ error: new LoopbackError("port_busy", port) });
          return;
        }
        if (index + 1 < hosts.length) listenOn(index + 1);
        done();
      });
      server.listen({ port: index === 0 ? port : boundPort, host, exclusive: true }, () => {
        const address = server.address();
        if (index === 0 && address && typeof address === "object") boundPort = address.port;
        listening += 1;
        if (index + 1 < hosts.length) listenOn(index + 1);
        done();
      });
    };
    listenOn(0);
  });
}
