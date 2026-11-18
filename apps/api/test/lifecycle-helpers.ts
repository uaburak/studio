import { env } from "cloudflare:workers";
import { Asset } from "@studio/contract";
import { expect } from "vitest";
import { BASE, localFetch } from "./helpers.ts";

/*
 * Helpers for the delete-safety, plan and bulk tests: real pictures (sharp must decode them),
 * uploads, and plans written straight into D1 (no chat turn needed).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typed = new TextEncoder().encode(type);
  out.set(typed, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A valid RGB PNG of one colour. */
export async function solidPng(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set([47, 93, 42], row + 1 + x * 3);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function uploadFile(
  brandId: string,
  bytes: Uint8Array<ArrayBuffer>,
  type = "image/png",
  name = "tarla.png",
  source: "upload" | "generated" = "upload",
): Promise<Asset> {
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("source", source);
  form.set("file", new File([bytes], name, { type }));
  const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(201);
  return Asset.parse(body);
}

/** A stored object exists in the MEDIA bucket. */
export async function stored(key: string): Promise<boolean> {
  return (await env.MEDIA.head(key)) !== null;
}

export interface SeedItem {
  date?: string | null;
  contentType?: "post" | "carousel" | "story" | "reel";
  title?: string;
  imageSlot?: "none" | "user_upload" | "ai_generate";
}

/** A proposed December plan of `brandId` written straight into D1 (no conversation). */
export async function seedPlan(brandId: string, items: SeedItem[]): Promise<string> {
  const now = Date.now();
  const planId = crypto.randomUUID();
  await env.DB.prepare(
    "insert into content_plans (id, brand_id, title, period_start, period_end, status, summary, revision, created_at, updated_at) values (?, ?, ?, ?, ?, 'proposed', '', 1, ?, ?)",
  )
    .bind(planId, brandId, "Aralık planı", "2026-12-01", "2026-12-31", now, now)
    .run();
  let position = 0;
  for (const item of items) {
    await env.DB.prepare(
      "insert into plan_items (id, plan_id, position, date, platforms, content_type, title, brief, pillar, image_slot, image_brief, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?, null, 'planned', ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        planId,
        position,
        item.date === undefined ? `2026-12-${String(position + 1).padStart(2, "0")}` : item.date,
        JSON.stringify(["instagram"]),
        item.contentType ?? "post",
        item.title ?? `Post ${position + 1}`,
        `Brief ${position + 1}`,
        item.imageSlot ?? "none",
        now,
        now,
      )
      .run();
    position++;
  }
  return planId;
}

/** Set a job's status in D1 directly (a finished generation without a worker). */
export async function finishJob(
  jobId: string,
  status: "succeeded" | "failed" | "cancelled",
  times?: { startedAt: number; finishedAt: number },
  error?: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "update jobs set status = ?, started_at = ?, finished_at = ?, error = ?, lease_expires_at = null, updated_at = ? where id = ?",
  )
    .bind(
      status,
      times?.startedAt ?? now - 1000,
      times?.finishedAt ?? now,
      error ?? (status === "failed" ? "üretim başarısız" : null),
      now,
      jobId,
    )
    .run();
}
