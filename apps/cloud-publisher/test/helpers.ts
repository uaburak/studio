import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { CloudOrder, CloudOrderCreate } from "@studio/contract";
import { createFakeEnv, FakeClock, type FakeEnvOptions } from "@studio/publishers/testing";
import { expect } from "vitest";
import type { Scheduler } from "../src/scheduler.ts";

export const BASE = "https://publisher.test";
export const PUBLISHER_TOKEN = "test-publisher-token";
export const AUTH = { authorization: `Bearer ${PUBLISHER_TOKEN}` };

// Shaped like Meta tokens so pattern-based redaction would also catch them.
export const USER_TOKEN = `EAAuser${"A".repeat(40)}`;
export const PAGE_TOKEN = `EAApage${"B".repeat(40)}`;
export const IG = "17841400000000001";
export const PAGE = "100200300400500";

/** Far in the future so alarms never fire on their own during a test. */
export const T0 = Date.UTC(2031, 0, 6, 9, 0, 0);
export const HOUR = 3600_000;

export const scheduler = () => env.SCHEDULER.getByName("main");

export interface Harness extends ReturnType<typeof createFakeEnv> {
  /** Set to throw from inside the driver right before a step result is persisted. */
  hooks: { beforePersist?: (info: { orderId: string; targetId: string; status: string }) => void };
  /** Steps whose results were persisted (or crashed) so far. */
  steps: number;
}

/** Wipe the Scheduler and point it at a fresh fake Graph API + fake clock. */
export async function setup(options: FakeEnvOptions = {}): Promise<Harness> {
  const clock = new FakeClock(T0);
  const fakeEnv = createFakeEnv({ ...options, clock });
  fakeEnv.fake.addUserToken(USER_TOKEN);
  fakeEnv.fake.addPage(PAGE, PAGE_TOKEN, { igUserId: IG, name: "MTM Agro" });
  const harness: Harness = { ...fakeEnv, hooks: {}, steps: 0 };
  await runInDurableObject(scheduler(), async (instance: Scheduler, state) => {
    state.storage.sql.exec("DELETE FROM orders; DELETE FROM targets; DELETE FROM log;");
    await state.storage.deleteAlarm();
    instance.deps = {
      clock,
      publisher: fakeEnv.publisher,
      beforePersist: (info) => {
        harness.steps++;
        harness.hooks.beforePersist?.(info);
      },
    };
  });
  return harness;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = AUTH,
): Promise<ApiResult<T>> {
  const res = await exports.default.fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = res.headers.get("content-type")?.includes("application/json")
    ? JSON.parse(text)
    : text;
  return { status: res.status, body: parsed as T, text, headers: res.headers };
}

export function expectError(res: ApiResult, status: number, code: string) {
  expect(res.status, res.text).toBe(status);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fakeJpeg(seed: number, size = 2048): Uint8Array {
  const out = new Uint8Array(size).map((_, i) => (i * 31 + seed * 7) % 251);
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return out;
}

export interface MediaFile {
  id: string;
  bytes: Uint8Array;
}

export async function mediaDecl(file: MediaFile, extra: Record<string, unknown> = {}) {
  return {
    id: file.id,
    kind: "image" as const,
    mimeType: "image/jpeg" as const,
    bytes: file.bytes.byteLength,
    sha256: await sha256Hex(file.bytes),
    width: 1080,
    height: 1350,
    altText: `Alt ${file.id}`,
    ...extra,
  };
}

export type Kind = CloudOrderCreate["targets"][number]["kind"];

export function target(kind: Kind, id: string = kind) {
  const instagram = kind.startsWith("instagram.");
  return {
    id,
    kind,
    accountExternalId: instagram ? IG : PAGE,
    accessToken: instagram ? USER_TOKEN : PAGE_TOKEN,
  };
}

export async function orderBody(
  files: MediaFile[],
  targets: ReturnType<typeof target>[],
  scheduledAt = T0 + HOUR,
  extra: Partial<CloudOrderCreate> = {},
): Promise<CloudOrderCreate> {
  return {
    contentId: "content-1",
    versionId: "version-1",
    contentHash: "a".repeat(64),
    scheduledAt: new Date(scheduledAt).toISOString(),
    caption: "Hasat zamanı #tarım",
    media: await Promise.all(files.map((f) => mediaDecl(f))),
    targets,
    ...extra,
  };
}

export async function upload(orderId: string, file: MediaFile, contentType = "image/jpeg") {
  const res = await exports.default.fetch(`${BASE}/v1/orders/${orderId}/media/${file.id}`, {
    method: "PUT",
    headers: { ...AUTH, "content-type": contentType },
    body: file.bytes,
  });
  const text = await res.text();
  return { status: res.status, text, body: text.startsWith("{") ? JSON.parse(text) : text };
}

/** Create an order and upload all its media; returns the ready order. */
export async function createReadyOrder(
  orderId: string,
  files: MediaFile[],
  targets: ReturnType<typeof target>[],
  scheduledAt = T0 + HOUR,
): Promise<CloudOrder> {
  const created = await api<CloudOrder>(
    "PUT",
    `/v1/orders/${orderId}`,
    await orderBody(files, targets, scheduledAt),
  );
  expect(created.status, created.text).toBe(201);
  let last: CloudOrder | undefined;
  for (const f of files) {
    const res = await upload(orderId, f);
    expect(res.status, res.text).toBe(200);
    last = res.body as CloudOrder;
  }
  expect(last?.status).toBe("scheduled");
  return last as CloudOrder;
}

export async function nextAlarm(): Promise<number | null> {
  return runInDurableObject(scheduler(), (_i: Scheduler, state) => state.storage.getAlarm());
}

/**
 * Wake the Scheduler repeatedly (as its alarm would), jumping the fake clock
 * to each next wake-up, until nothing is left to do. Crashes thrown from the
 * hook are swallowed: the next wake-up resumes from persisted state.
 */
export async function runUntilIdle(h: Harness, maxWakeups = 200): Promise<number> {
  let crashes = 0;
  for (let i = 0; i < maxWakeups; i++) {
    // Catch inside the object so the simulated crash does not surface as an RPC error.
    const crashed = await runInDurableObject(scheduler(), async (instance: Scheduler) => {
      try {
        await instance.tick();
        return null;
      } catch (err) {
        return String(err);
      }
    });
    if (crashed !== null) {
      if (!crashed.includes("simulated crash")) throw new Error(crashed);
      crashes++;
      h.clock.advance(10_000);
      continue;
    }
    const next = await nextAlarm();
    if (next === null) return crashes;
    if (next > h.clock.now() + 2 * 24 * HOUR) return crashes; // only the media purge is left
    h.clock.t = Math.max(h.clock.t, next);
  }
  throw new Error("runUntilIdle: too many wake-ups");
}
