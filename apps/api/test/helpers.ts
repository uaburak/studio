import { exports } from "cloudflare:workers";
import type {
  ApiErrorBody,
  Brand,
  Content,
  ContentCreate,
  ContentVersion,
  ContentVersionCreate,
  SlideInput,
  SocialAccount,
} from "@studio/contract";
import { expect } from "vitest";

/** The Mac app addresses the API by a loopback name (the `local` principal requires it). */
export const BASE = "http://127.0.0.1:8790";

/** The desktop app's owner secret in tests (`STUDIO_OWNER_SECRET`, vitest.config.ts). */
export const OWNER_SECRET = "test-owner-secret";

/**
 * Headers that make a request look like it came from the Mac app itself: the loopback peer
 * Miniflare would set from the socket (tests have no socket) and the app's owner secret.
 */
export const LOCAL = { "CF-Connecting-IP": "127.0.0.1", "X-Studio-Owner": OWNER_SECRET } as const;

/** `exports.default.fetch` as the Mac app would call it (127.0.0.1 + owner secret). */
export function localFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(LOCAL)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return exports.default.fetch(input, { ...init, headers });
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/** Call the Worker with an optional JSON body; parses JSON responses. */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await localFetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (res.headers.get("content-type")?.includes("application/json")) parsed = JSON.parse(text);
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** Assert the contract error shape and return the code. */
export function expectError(res: ApiResult, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const body = res.body as ApiErrorBody;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body.error;
}

let counter = 0;
export function uniq(prefix = "t"): string {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function createBrand(overrides: Record<string, unknown> = {}): Promise<Brand> {
  const res = await api<Brand>("POST", "/api/brands", {
    name: "Test Brand",
    slug: uniq("brand"),
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

export async function createAccount(
  brandId: string,
  overrides: Record<string, unknown> = {},
): Promise<SocialAccount> {
  const res = await api<SocialAccount>("POST", "/api/social-accounts", {
    brandId,
    platform: "instagram",
    handle: "@test",
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

export async function createContent(
  brandId: string,
  overrides: Partial<ContentCreate> = {},
): Promise<Content> {
  const res = await api<Content>("POST", "/api/contents", {
    brandId,
    type: "post",
    title: "Hasat duyurusu",
    targetPlatforms: ["instagram"],
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

export const slide = (html = "<html><body>v1</body></html>"): SlideInput => ({
  html,
  width: 1080,
  height: 1350,
});

export async function addVersion(
  contentId: string,
  input: Partial<ContentVersionCreate> = {},
): Promise<ContentVersion> {
  const res = await api<ContentVersion>("POST", `/api/contents/${contentId}/versions`, {
    origin: "generated",
    slides: [slide()],
    ...input,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

export async function getContent(id: string): Promise<Content> {
  const res = await api<Content>("GET", `/api/contents/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Content with one version, approved by hash. */
export async function approvedContent(brandId: string, overrides: Partial<ContentCreate> = {}) {
  const content = await createContent(brandId, overrides);
  const version = await addVersion(content.id);
  // No check run: the user approves without waiting for the checks (E7).
  const res = await api<Content>("POST", `/api/contents/${content.id}/approve`, {
    hash: version.contentHash,
    acknowledgeChecks: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { content: res.body, version };
}

export const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
