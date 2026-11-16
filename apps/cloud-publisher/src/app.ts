/**
 * HTTP surface.
 *
 * - `/v1/*`: the Mac's API. Every request needs
 *   `Authorization: Bearer <PUBLISHER_TOKEN>` (constant-time compare).
 *   CLOUDFLARE ACCESS: when Access fronts this hostname, protect `/v1/*`
 *   with a service-token policy (the Mac sends CF-Access-Client-Id/Secret);
 *   keep the bearer check as defence in depth.
 * - `/media/*`: public on purpose (Meta downloads from here), guarded only by
 *   an HMAC signature with an expiry. Access must BYPASS this path.
 * - `/health`: unauthenticated liveness, no data.
 */

import {
  CLOUD_MAX_MEDIA_BYTES,
  CLOUD_PUBLISHER_ERROR_STATUS,
  CloudOrderCreate,
  CloudOrderListQuery,
  type CloudPublisherErrorBody,
  type CloudPublisherErrorCode,
} from "@studio/contract";
import { Hono } from "hono";
import type { z } from "zod";
import { isAuthorized, verifyMediaSignature } from "./crypto.ts";
import type { RpcResult } from "./scheduler.ts";

type AppEnv = { Bindings: Env };

export const app = new Hono<AppEnv>();

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function errorResponse(
  code: CloudPublisherErrorCode,
  message: string,
  issues?: { path: string; message: string }[],
): Response {
  const body: CloudPublisherErrorBody = { error: { code, message, ...(issues ? { issues } : {}) } };
  return Response.json(body, { status: CLOUD_PUBLISHER_ERROR_STATUS[code] });
}

function zodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

function reply<T>(result: RpcResult<T>, status = 200): Response {
  if (!result.ok)
    return errorResponse(result.error.code, result.error.message, result.error.issues);
  return Response.json(result.value, { status });
}

const scheduler = (env: Env) => env.SCHEDULER.getByName("main");

app.get("/health", (c) => c.json({ ok: true }));

// --- signed media (public) -------------------------------------------------------------

app.on(["GET", "HEAD"], "/media/:orderId/:exp/:sig/:mediaId", async (c) => {
  const { orderId, exp, sig, mediaId } = c.req.param();
  const check = await verifyMediaSignature(
    c.env.MEDIA_URL_SECRET,
    orderId,
    mediaId,
    exp,
    sig,
    Date.now(),
  );
  const plain = { "content-type": "text/plain", "cache-control": "no-store" };
  if (check === "invalid") return new Response("forbidden", { status: 403, headers: plain });
  if (check === "expired") return new Response("expired", { status: 410, headers: plain });

  const ref = await scheduler(c.env).mediaObject(orderId, mediaId);
  if (!ref) return new Response("not found", { status: 404, headers: plain });
  const object = await c.env.MEDIA.get(ref.key, { range: c.req.raw.headers });
  if (!object) return new Response("not found", { status: 404, headers: plain });

  const headers = new Headers({
    "content-type": ref.mimeType,
    etag: object.httpEtag,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  let status = 200;
  let length = object.size;
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && c.req.header("range")) {
    const offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
    length = range.suffix ?? range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    status = 206;
  }
  headers.set("content-length", String(length));
  return new Response(c.req.method === "HEAD" ? null : object.body, { status, headers });
});

// --- Mac API (bearer) ------------------------------------------------------------------

app.use("/v1/*", async (c, next) => {
  if (!(await isAuthorized(c.env.PUBLISHER_TOKEN, c.req.header("authorization") ?? null))) {
    return errorResponse("unauthorized", "missing or invalid bearer token");
  }
  await next();
});

app.use("/v1/orders/:orderId/*", async (c, next) => {
  if (!ID_RE.test(c.req.param("orderId"))) return errorResponse("not_found", "order not found");
  await next();
});

app.put("/v1/orders/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  if (!ID_RE.test(orderId)) return errorResponse("validation_error", "invalid order id");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return errorResponse("validation_error", "body must be JSON");
  }
  const parsed = CloudOrderCreate.safeParse(json);
  if (!parsed.success) {
    return errorResponse("validation_error", "invalid order", zodIssues(parsed.error));
  }
  const result = await scheduler(c.env).putOrder(orderId, parsed.data);
  if (!result.ok) return reply(result);
  return Response.json(result.value.order, { status: result.value.created ? 201 : 200 });
});

app.put("/v1/orders/:orderId/media/:mediaId", async (c) => {
  const { orderId, mediaId } = c.req.param();
  const stub = scheduler(c.env);
  const prep = await stub.prepareUpload(orderId, mediaId);
  if (!prep.ok) return reply(prep);
  const { key, sha256, bytes, mimeType } = prep.value;

  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== mimeType) {
    return errorResponse("unsupported_media_type", `content-type must be ${mimeType}`);
  }
  const length = Number(c.req.header("content-length"));
  if (!Number.isInteger(length) || length <= 0) {
    return errorResponse("validation_error", "Content-Length is required");
  }
  if (length > CLOUD_MAX_MEDIA_BYTES) return errorResponse("payload_too_large", "file too large");
  if (length !== bytes) {
    return errorResponse("validation_error", `expected ${bytes} bytes, got ${length}`);
  }
  if (!c.req.raw.body) return errorResponse("validation_error", "empty body");
  try {
    // R2 verifies the SHA-256 server-side and rejects the write on mismatch.
    await c.env.MEDIA.put(key, c.req.raw.body, {
      sha256,
      httpMetadata: { contentType: mimeType },
    });
  } catch {
    return errorResponse("validation_error", "upload does not match the declared sha256");
  }
  return reply(await stub.confirmUpload(orderId, mediaId, sha256));
});

app.post("/v1/orders/:orderId/cancel", async (c) =>
  reply(await scheduler(c.env).cancelOrder(c.req.param("orderId"))),
);

app.get("/v1/orders", async (c) => {
  const parsed = CloudOrderListQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return errorResponse("validation_error", "invalid query", zodIssues(parsed.error));
  }
  return reply(await scheduler(c.env).listOrders(parsed.data));
});

app.get("/v1/orders/:orderId", async (c) =>
  reply(await scheduler(c.env).getOrder(c.req.param("orderId"))),
);

app.get("/v1/orders/:orderId/log", async (c) =>
  reply(await scheduler(c.env).getLog(c.req.param("orderId"))),
);

app.notFound(() => errorResponse("not_found", "route not found"));

app.onError((err) => {
  // Never echo internals; the message may not be redacted.
  console.error(JSON.stringify({ event: "unhandled", name: err.name }));
  return errorResponse("internal_error", "internal error");
});
