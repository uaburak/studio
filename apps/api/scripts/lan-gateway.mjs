#!/usr/bin/env node
// LAN gateway for the Mac-hosted API (task L1).
//
// workerd (wrangler dev) listens on 127.0.0.1 only. Phones on the local
// network (and, through `cloudflared`, Remote Control) reach it through this
// small reverse proxy, which
//   - overwrites `CF-Connecting-IP` with the real peer address (Miniflare
//     would keep a client-supplied value, so "127.0.0.1" could be spoofed).
//     Only when the peer is this Mac's loopback (the Cloudflare Tunnel
//     connector) does it keep the address Cloudflare's edge put there, so
//     per-client pairing limits tell tunnel clients apart; gatewayed requests
//     are never the Mac itself, so a faked value only picks another bucket,
//   - adds `X-Studio-Gateway: 1`, so the API never treats gatewayed traffic as
//     the Mac itself (src/middleware/access.ts), even from 127.0.0.1,
//   - drops a client-sent `X-Studio-Owner` (only the Mac app talks to workerd
//     directly with it),
//   - forwards HTTP and WebSocket upgrades unchanged otherwise.
//
// Started and supervised by the Mac app. Environment:
//   STUDIO_GATEWAY_HOST   listen address (default 0.0.0.0)
//   STUDIO_GATEWAY_PORT   listen port (required)
//   STUDIO_API_PORT       upstream port on 127.0.0.1 (required)
// No dependencies: Node's http/net only.
import http from "node:http";
import net from "node:net";

const host = process.env.STUDIO_GATEWAY_HOST || "0.0.0.0";
const port = Number(process.env.STUDIO_GATEWAY_PORT);
const upstreamPort = Number(process.env.STUDIO_API_PORT);
const upstreamHost = "127.0.0.1";
if (!Number.isInteger(port) || !Number.isInteger(upstreamPort)) {
  console.error("lan-gateway: STUDIO_GATEWAY_PORT and STUDIO_API_PORT are required");
  process.exit(2);
}

// Hop-by-hop headers (RFC 9110 §7.6.1) and the ones this gateway owns.
const DROP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-studio-gateway",
  "x-studio-owner",
]);

function peer(socket) {
  const address = socket.remoteAddress ?? "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

const IP_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i;

/** The client address the API sees (see the header comment for the tunnel case). */
function clientAddressFor(peerAddress, forwarded) {
  const loopback = peerAddress === "::1" || peerAddress.startsWith("127.");
  const value = typeof forwarded === "string" ? forwarded.trim() : "";
  if (loopback && IP_ADDRESS.test(value)) return value;
  return peerAddress;
}

/** Copy client headers minus hop-by-hop ones, then stamp ours. */
function forwardHeaders(req, { upgrade }) {
  const headers = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (DROP.has(name.toLowerCase())) continue;
    if (headers[name] === undefined) headers[name] = value;
    else headers[name] = [].concat(headers[name], value);
  }
  headers["CF-Connecting-IP"] = clientAddressFor(peer(req.socket), req.headers["cf-connecting-ip"]);
  headers["X-Studio-Gateway"] = "1";
  if (upgrade) {
    headers.Connection = "Upgrade";
    headers.Upgrade = req.headers.upgrade;
  }
  return headers;
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, { upgrade: false }),
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders);
      up.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "internal_error", message: "API is not reachable" } }),
      );
    } else {
      res.destroy(error);
    }
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    const headers = forwardHeaders(req, { upgrade: true });
    let head_ = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(headers)) {
      for (const v of [].concat(value)) head_ += `${name}: ${v}\r\n`;
    }
    upstream.write(`${head_}\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
});

server.on("clientError", (_error, socket) => socket.destroy());

server.listen(port, host, () => {
  console.log(`lan-gateway: http://${host}:${port} -> http://${upstreamHost}:${upstreamPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
