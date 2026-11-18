// A post's Wecra document as one file (`EditorDocument`, format 1): the asset a version saved
// from the canvas carries. A zip (Wecra's own writer, stored entries):
//
//   meta.json          { format, kind: "wecra", wecra: { appVersion, commit, abiVersion },
//                        slides: [{ guid, name, width, height }], images: [sha1…],
//                        sourceVersion: the HTML version the document was imported from }
//   document.kiwi      the document as Wecra's engine writes its snapshots (a kiwi Message in
//                      Wecra's own schema: lossless, Wecra-only fields included)
//   images/<sha1>      each image the document uses (Wecra's images are keyed by SHA-1)
//
// The slides are the page's top-level frames in reading order (exporting.ts `pageFrames`).
import { readZip, writeZip } from "@shared/fig/zip";
import { decodeMessage } from "@shared/schema/codec";
import { type ImageStore, sha1Hex } from "@/editor/images";
import type { Message } from "@/engine/codec";
import { messageToEngine } from "@/store/engineMessage";
import { WECRA_VERSION } from "../../../vendor/wecra-editor/studio/version.ts";

export const BUNDLE_FORMAT = 1;

export interface BundleSlide {
  guid: string;
  name: string;
  width: number;
  height: number;
}

export interface BundleMeta {
  format: number;
  kind: "wecra";
  wecra: { appVersion: string; commit: string; abiVersion: number };
  slides: BundleSlide[];
  images: string[];
  /** The post's HTML version the document was first imported from (null: unknown). */
  sourceVersion: number | null;
}

/** The images a post's document keeps, by SHA-1 (Wecra's ImageStore, in memory). */
export class BundleImages implements ImageStore {
  readonly map = new Map<string, Uint8Array>();

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

const json = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);

/**
 * The document (the engine's kiwi snapshot, `Engine.encodeDocumentKiwi`) and the images it uses,
 * as the bundle's bytes.
 */
export function encodeBundle(
  document: Uint8Array,
  images: BundleImages,
  slides: readonly BundleSlide[],
  sourceVersion: number | null = null,
): Uint8Array {
  const used = [...imageHashesIn(decodeMessage(document))].filter((h) => images.map.has(h)).sort();
  const meta: BundleMeta = {
    format: BUNDLE_FORMAT,
    kind: "wecra",
    wecra: { ...WECRA_VERSION },
    slides: [...slides],
    images: used,
    sourceVersion,
  };
  const entries = [
    { name: "meta.json", data: json(meta) },
    { name: "document.kiwi", data: document },
    ...used.map((hash) => ({ name: `images/${hash}`, data: images.map.get(hash) as Uint8Array })),
  ];
  return writeZip(entries);
}

export interface DecodedBundle {
  meta: BundleMeta;
  message: Message;
  images: BundleImages;
}

/** A bundle's document (in the engine's JSON shape) and its images. */
export function decodeBundle(bytes: Uint8Array): DecodedBundle {
  const entries = readZip(bytes);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const metaBytes = byName.get("meta.json");
  const doc = byName.get("document.kiwi");
  if (!metaBytes || !doc) throw new Error("Wecra belgesi eksik (meta.json / document.kiwi).");
  const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as BundleMeta;
  if (meta.kind !== "wecra" || meta.format > BUNDLE_FORMAT)
    throw new Error(`Bu Wecra belgesi daha yeni bir biçimde (${meta.format}).`);
  const images = new BundleImages();
  for (const e of entries)
    if (e.name.startsWith("images/")) images.map.set(e.name.slice("images/".length), e.data);
  return { meta, message: messageToEngine(decodeMessage(doc)), images };
}
