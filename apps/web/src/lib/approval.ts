import { type ContentVersion, computeContentHash } from "@studio/contract";

export type HashCheck =
  | { kind: "verified"; hash: string }
  /** WebCrypto unavailable (plain-http LAN address on a phone): trust the server hash. */
  | { kind: "unverifiable"; hash: string }
  | { kind: "mismatch"; local: string; server: string };

/**
 * Recompute the version hash from the slides the user is looking at, so the
 * approval provably refers to this exact design (README: "istemci aynı
 * fonksiyonla doğrulayabilir").
 */
export async function verifyVersionHash(
  version: Pick<ContentVersion, "slides" | "contentHash">,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<HashCheck> {
  if (!subtle) return { kind: "unverifiable", hash: version.contentHash };
  const local = await computeContentHash(version.slides);
  return local === version.contentHash
    ? { kind: "verified", hash: local }
    : { kind: "mismatch", local, server: version.contentHash };
}
