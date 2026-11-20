// The only way the MCP server talks to Studio: HTTP to the loopback API as the owner.
//
// The owner secret is read from its file on every call (the app may rotate it) and only ever
// goes into the `X-Studio-Owner` request header. It is never logged, returned or stored; the
// client also exposes `scrub()` so callers can remove it from anything they hand back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkBaseUrl,
  OWNER_HEADER,
  OWNER_SECRET_FILE,
  resolveBaseUrl,
  stateDirectory,
} from "./config.ts";

export const STUDIO_DOWN_MESSAGE =
  "Studio açık değil: Mac uygulamasını başlatın. (Studio is not running: start the Mac app.)";

export type StudioErrorCode = "unavailable" | "no_secret" | "unauthorized" | "refused" | "timeout";

export class StudioError extends Error {
  readonly code: StudioErrorCode;

  constructor(message: string, code: StudioErrorCode) {
    super(message);
    this.code = code;
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface StudioRequest {
  method: HttpMethod;
  /** Absolute API path, e.g. `/api/brands/abc` (already encoded). */
  path: string;
  query?: Record<string, unknown>;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
}

export interface StudioResponse {
  status: number;
  contentType: string;
  /** Parsed body when the response is JSON. */
  json?: unknown;
  /** Body text for other textual responses. */
  text?: string;
  /** Raw bytes for binary responses (images, video, fonts …). */
  bytes?: Uint8Array;
}

export interface StudioClientOptions {
  /** Loopback base URL; default: STUDIO_API_URL, host.json's port, or 8790. */
  baseUrl?: string;
  /** Studio's state folder (holds `owner-secret`); default ~/Library/Application Support/Studio. */
  stateDir?: string;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
}

const MIN_SECRET_LENGTH = 32;

function isTextual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript")
  );
}

function queryValue(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(queryValue);
  if (typeof value === "object") return [JSON.stringify(value)];
  return [String(value)];
}

export class StudioClient {
  readonly baseUrl: string;
  readonly stateDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  /** Last secret read, kept only to scrub it from outputs (never written anywhere). */
  private lastSecret: string | null = null;

  constructor(options: StudioClientOptions = {}) {
    this.stateDir = options.stateDir ?? stateDirectory();
    this.baseUrl = options.baseUrl
      ? checkBaseUrl(options.baseUrl)
      : resolveBaseUrl(process.env, this.stateDir);
    this.fetchImpl = options.fetch ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  }

  private ownerSecret(): string {
    let secret: string;
    try {
      secret = readFileSync(join(this.stateDir, OWNER_SECRET_FILE), "utf8").trim();
    } catch {
      throw new StudioError(
        "Studio'nun sahip anahtarı bulunamadı; Mac uygulamasını bir kez başlatın. " +
          "(The owner secret was not found: start the Mac app once.)",
        "no_secret",
      );
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new StudioError(
        "Studio'nun sahip anahtarı geçersiz. (The owner secret file is invalid.)",
        "no_secret",
      );
    }
    this.lastSecret = secret;
    return secret;
  }

  /** Removes the owner secret from a string (defence in depth for everything returned). */
  scrub(text: string): string {
    const secret = this.lastSecret;
    if (!secret || !text.includes(secret)) return text;
    return text.split(secret).join("[gizli]");
  }

  /** Builds the request URL and refuses anything that would leave the loopback API. */
  url(path: string, query?: Record<string, unknown>): URL {
    if (!path.startsWith("/api/") || path.includes("..") || /[\s\\#?]/.test(path)) {
      throw new StudioError(`geçersiz API yolu: ${path}`, "refused");
    }
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl) throw new StudioError("API dışı adres reddedildi", "refused");
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const item of queryValue(value)) url.searchParams.append(key, item);
    }
    return url;
  }

  async request(req: StudioRequest): Promise<StudioResponse> {
    const url = this.url(req.path, req.query);
    const headers: Record<string, string> = { [OWNER_HEADER]: this.ownerSecret() };
    let body: FormData | string | undefined;
    if (req.form) {
      body = req.form;
    } else if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    }
    const signal = AbortSignal.timeout(req.timeoutMs ?? this.defaultTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal,
      });
    } catch {
      if (signal.aborted) {
        throw new StudioError(
          `Studio yanıt vermedi (${req.method} ${req.path}). (Studio did not answer in time.)`,
          "timeout",
        );
      }
      throw new StudioError(STUDIO_DOWN_MESSAGE, "unavailable");
    }
    if (res.status === 401) {
      await res.body?.cancel();
      throw new StudioError(
        "Studio sahip anahtarını kabul etmedi; Mac uygulamasını yeniden başlatın. " +
          "(Studio refused the owner secret: restart the Mac app.)",
        "unauthorized",
      );
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const out: StudioResponse = { status: res.status, contentType };
    if (res.status === 204) return out;
    if (contentType.includes("json")) {
      const text = await res.text();
      try {
        out.json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        out.text = text;
      }
    } else if (isTextual(contentType) || contentType === "") {
      out.text = await res.text();
    } else {
      out.bytes = new Uint8Array(await res.arrayBuffer());
    }
    return out;
  }
}
