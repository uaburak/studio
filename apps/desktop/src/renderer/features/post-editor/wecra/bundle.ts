// A post's Wecra document as one file (`EditorDocument`): the asset a version saved from the
// canvas carries, and the working draft this Mac keeps (shared/drafts.ts). A zip (Wecra's own
// writer, stored entries):
//
//   meta.json          { format, kind: "wecra", wecra: { appVersion, commit, abiVersion },
//                        slides: [{ guid, name, width, height }], images: [sha1…],
//                        assets: { sha1: { assetId, sha256, mimeType, bytes } },
//                        sourceVersion: the HTML version the document was imported from }
//   document.kiwi      the document as Wecra's engine writes its snapshots (a kiwi Message in
//                      Wecra's own schema: lossless, Wecra-only fields included)
//   images/<sha1>      an image the document uses that is not an asset of the brand (yet)
//
// Format 2 (E13): the pictures are the brand's assets, content-addressed — `assets` maps each
// image (Wecra keys them by SHA-1) to the asset holding its bytes, so a bundle is the document and
// references, and an unchanged picture is never uploaded again (dedupe by SHA-256, assets.ts). A
// draft keeps the pictures not uploaded yet inside (`images/`). Format 1 (every image inside)
// still opens.
//
// The slides are the page's top-level frames in reading order (exporting.ts `pageFrames`).
import { readZip, writeZip } from "@shared/fig/zip";
import { decodeMessage } from "@shared/schema/codec";
import { type ImageStore, sha1Hex } from "@/editor/images";
import type { Message } from "@/engine/codec";
import { messageToEngine } from "@/store/engineMessage";
import { WECRA_VERSION } from "../../../vendor/wecra-editor/studio/version.ts";

export const BUNDLE_FORMAT = 2;

export interface BundleSlide {
  guid: string;
  name: string;
  width: number;
  height: number;
}

/** An image kept as an asset of the brand (its bytes are not in the bundle). */
export interface BundleImageRef {
  assetId: string;
  /** Hex SHA-256 of the bytes (the API's `Asset.sha256`). */
  sha256: string;
  mimeType: string;
  bytes: number;
}

export interface BundleMeta {
  format: number;
  kind: "wecra";
  wecra: { appVersion: string; commit: string; abiVersion: number };
  slides: BundleSlide[];
  /** Every image the document uses (SHA-1). */
  images: string[];
  /** Format 2: the images held by assets (SHA-1 → asset); the others are in `images/`. */
  assets?: Record<string, BundleImageRef>;
  /** The post's HTML version the document was first imported from (null: unknown). */
  sourceVersion: number | null;
}

/**
 * The images a post's document keeps, by SHA-1 (Wecra's ImageStore, in memory), and which of them
 * are assets of the brand already (`assets`; `known`: every asset seen by its SHA-256, for the
 * dedupe of the next save).
 */
export class BundleImages implements ImageStore {
  readonly map = new Map<string, Uint8Array>();
  /** SHA-1 → the asset holding the image. */
  readonly assets = new Map<string, BundleImageRef>();
  /** SHA-256 → an asset with those bytes (the bundle's refs, the import's pictures, uploads). */
  readonly known = new Map<string, BundleImageRef>();

  constructor(entries?: Iterable<[string, Uint8Array]>) {
    if (entries) for (const [hash, bytes] of entries) this.map.set(hash, bytes);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = await sha1Hex(bytes);
    this.map.set(hash, bytes);
    return hash;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.map.get(hash) ?? null;
  }

  /** `sha1`'s bytes are held by `ref`. */
  link(sha1: string, ref: BundleImageRef): void {
    this.assets.set(sha1, ref);
    this.known.set(ref.sha256, ref);
  }

  /** An asset with these bytes exists (a picture the import read from the brand's media). */
  remember(ref: BundleImageRef): void {
    this.known.set(ref.sha256, ref);
  }
}

const HASH = /^[0-9a-f]{40}$/;

const hex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, "0")).join("");

/**
 * The images the document uses, by SHA-1: every `hash` of its paints (an image fill, a video's
 * poster, an animated image, a thumbnail — Wecra writes them as 20 bytes) and any SHA-1 string.
 */
export function imageHashesIn(message: { nodeChanges?: unknown }): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      if (HASH.test(v)) out.add(v);
    } else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (v && typeof v === "object") {
      const hash = (v as { hash?: unknown }).hash;
      if ((Array.isArray(hash) || hash instanceof Uint8Array) && hash.length === 20)
        out.add(hex(hash as ArrayLike<number>));
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(message.nodeChanges);
  return out;
}

/** The images `document` uses that this store has (bytes or an asset). */
export function usedImages(document: Uint8Array, images: BundleImages): string[] {
  return [...imageHashesIn(decodeMessage(document))]
    .filter((h) => images.map.has(h) || images.assets.has(h))
    .sort();
}

const json = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);

/**
 * The document (the engine's kiwi snapshot, `Engine.encodeDocumentKiwi`) and the images it uses,
 * as the bundle's bytes: an image that is an asset as a reference, any other inside.
 */
export function encodeBundle(
  document: Uint8Array,
  images: BundleImages,
  slides: readonly BundleSlide[],
  sourceVersion: number | null = null,
): Uint8Array {
  const used = usedImages(document, images);
  const assets: Record<string, BundleImageRef> = {};
  const inside: string[] = [];
  for (const hash of used) {
    const ref = images.assets.get(hash);
    if (ref) assets[hash] = { ...ref };
    else if (images.map.has(hash)) inside.push(hash);
  }
  const meta: BundleMeta = {
    format: BUNDLE_FORMAT,
    kind: "wecra",
    wecra: { ...WECRA_VERSION },
    slides: [...slides],
    images: used,
    assets,
    sourceVersion,
  };
  const entries = [
    { name: "meta.json", data: json(meta) },
    { name: "document.kiwi", data: document },
    ...inside.map((hash) => ({ name: `images/${hash}`, data: images.map.get(hash) as Uint8Array })),
  ];
  return writeZip(entries);
}

export interface DecodedBundle {
  meta: BundleMeta;
  message: Message;
  images: BundleImages;
  /** Images held by assets whose bytes still have to be read (`loadBundle` reads them). */
  pending: string[];
  /** After `loadBundle`: images whose asset could not be read (deleted from Medya?). */
  missing?: string[];
}

const isRef = (v: unknown): v is BundleImageRef =>
  !!v &&
  typeof v === "object" &&
  typeof (v as BundleImageRef).assetId === "string" &&
  typeof (v as BundleImageRef).sha256 === "string";

/** A bundle's document (in the engine's JSON shape), its images inside and its image assets. */
export function decodeBundle(bytes: Uint8Array): DecodedBundle {
  const entries = readZip(bytes);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const metaBytes = byName.get("meta.json");
  const doc = byName.get("document.kiwi");
  if (!metaBytes || !doc) throw new Error("Wecra belgesi eksik (meta.json / document.kiwi).");
  const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as BundleMeta;
  if (meta.kind !== "wecra" || !(meta.format >= 1) || meta.format > BUNDLE_FORMAT)
    throw new Error(`Bu Wecra belgesi daha yeni bir biçimde (${meta.format}).`);
  const images = new BundleImages();
  for (const e of entries)
    if (e.name.startsWith("images/")) images.map.set(e.name.slice("images/".length), e.data);
  const pending: string[] = [];
  for (const [sha1, ref] of Object.entries(meta.assets ?? {})) {
    if (!HASH.test(sha1) || !isRef(ref)) continue;
    images.link(sha1, ref);
    if (!images.map.has(sha1)) pending.push(sha1);
  }
  return { meta, message: messageToEngine(decodeMessage(doc)), images, pending };
}

/**
 * `decodeBundle` with the pictures held by assets read (`fetchAsset`), in parallel. One that can't
 * be read is left out (`missing`: the layer draws empty, its reference is kept).
 */
export async function loadBundle(
  bytes: Uint8Array,
  fetchAsset: (assetId: string) => Promise<Uint8Array>,
): Promise<DecodedBundle> {
  const decoded = decodeBundle(bytes);
  const missing: string[] = [];
  await Promise.all(
    decoded.pending.map(async (sha1) => {
      const ref = decoded.images.assets.get(sha1);
      if (!ref) return;
      try {
        decoded.images.map.set(sha1, await fetchAsset(ref.assetId));
      } catch {
        missing.push(sha1);
      }
    }),
  );
  return { ...decoded, pending: [], missing };
}
