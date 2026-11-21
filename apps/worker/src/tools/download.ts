// Streaming download with progress and a hash computed on the way (tool installs, tools/manager.ts).
// Nothing is unpacked before the hash matched; a mismatch deletes the file and refuses.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";

export class ToolVerifyError extends Error {
  override name = "ToolVerifyError";
}

export interface DownloadOptions {
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Called with (bytes received, total or null) at most every ~250 ms and at the end. */
  onProgress?: (received: number, total: number | null) => void;
  /** Refuse anything larger (default 1.5 GB). */
  maxBytes?: number;
}

export interface Expected {
  /** Lower-case hex SHA-256, or an npm integrity string (`sha512-<base64>`). */
  sha256?: string;
  integrity?: string;
  /** Exact size in bytes, when known. */
  size?: number;
}

/** Download `url` into `file`; checks size and hash; throws ToolVerifyError on mismatch. */
export async function downloadVerified(
  url: string,
  file: string,
  expected: Expected,
  options: DownloadOptions,
): Promise<{ bytes: number; sha256: string }> {
  if (!url.startsWith("https://")) throw new ToolVerifyError(`yalnızca https indirilir: ${url}`);
  if (!expected.sha256 && !expected.integrity) {
    throw new ToolVerifyError("indirmenin doğrulanacağı bir özet yok");
  }
  const res = await options.fetch(url, {
    redirect: "follow",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok || !res.body) {
    throw new Error(`indirilemedi (HTTP ${res.status}): ${url}`);
  }
  const header = Number(res.headers.get("content-length"));
  const total = expected.size ?? (Number.isFinite(header) && header > 0 ? header : null);
  const max = options.maxBytes ?? 1_500_000_000;
  const sha256 = createHash("sha256");
  const integrityAlgo = expected.integrity?.split("-")[0];
  const integrityHash =
    integrityAlgo === "sha512" || integrityAlgo === "sha384" || integrityAlgo === "sha256"
      ? createHash(integrityAlgo)
      : null;
  if (expected.integrity && !integrityHash) {
    throw new ToolVerifyError(`bilinmeyen bütünlük biçimi: ${expected.integrity.slice(0, 20)}`);
  }
  const out = createWriteStream(file, { mode: 0o600 });
  let received = 0;
  let last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > max) throw new ToolVerifyError("indirme beklenenden çok büyük");
      sha256.update(value);
      integrityHash?.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      const now = Date.now();
      if (now - last > 250) {
        last = now;
        options.onProgress?.(received, total);
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    options.onProgress?.(received, total);
    const digest = sha256.digest("hex");
    if (expected.size !== undefined && received !== expected.size) {
      throw new ToolVerifyError(
        `boyut tutmuyor (beklenen ${expected.size} bayt, gelen ${received}); kurulmadı`,
      );
    }
    if (expected.sha256 && digest !== expected.sha256.toLowerCase()) {
      throw new ToolVerifyError(
        `SHA-256 tutmuyor (beklenen ${expected.sha256.slice(0, 12)}…, gelen ${digest.slice(0, 12)}…); kurulmadı`,
      );
    }
    if (expected.integrity && integrityHash) {
      const got = `${integrityAlgo}-${integrityHash.digest("base64")}`;
      if (got !== expected.integrity) {
        throw new ToolVerifyError("npm bütünlük özeti (integrity) tutmuyor; kurulmadı");
      }
    }
    return { bytes: received, sha256: digest };
  } catch (error) {
    out.destroy();
    await rm(file, { force: true });
    throw error;
  }
}

/** Percent values in an installer's output ("… 42% of 90 MiB"), as 0..100. */
export function parseInstallProgress(text: string): number | null {
  const matches = [...text.matchAll(/(\d{1,3})%/g)];
  const lastMatch = matches.at(-1)?.[1];
  if (lastMatch === undefined) return null;
  const value = Number(lastMatch);
  return value >= 0 && value <= 100 ? value : null;
}
