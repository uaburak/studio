// A brand's font file as Wecra's text engine reads it (E9): the engine shapes with sfnt fonts
// (TrueType / OpenType: `\0\1\0\0`, `true`, `OTTO`, collections `ttcf`) only, while brands upload
// web fonts too. WOFF (1.0) is an sfnt whose tables are zlib-compressed one by one: they are
// inflated (the platform's DecompressionStream) and the sfnt is written back. WOFF2 is Brotli plus
// table transforms: decoded by Google's woff2 decoder (woff2-encoder's WebAssembly build, its
// decompress-only entry, loaded when the first WOFF2 file is read). Anything else is passed on as
// it is (the engine says when it can't read it: the family is "missing").

export type FontFileFormat = "sfnt" | "woff" | "woff2" | "unknown";

const tag = (b: Uint8Array) => (b.length >= 4 ? String.fromCharCode(...b.subarray(0, 4)) : "");

/** What a font file is, by its first four bytes. */
export function fontFileFormat(bytes: Uint8Array): FontFileFormat {
  const t = tag(bytes);
  if (t === "wOFF") return "woff";
  if (t === "wOF2") return "woff2";
  if (t === "\0\x01\0\0" || t === "true" || t === "OTTO" || t === "ttcf" || t === "typ1")
    return "sfnt";
  return "unknown";
}

/** Larger than any font a brand uploads: a corrupt header can't make us allocate more. */
const MAX_SFNT_BYTES = 64 * 1024 * 1024;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined")
    throw new Error("Bu ortamda WOFF açılamıyor (DecompressionStream yok).");
  const stream = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** WOFF 1.0 → the sfnt it wraps (W3C WOFF 1.0 §4–§5). */
export async function woffToSfnt(woff: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (woff.byteLength < 44 || tag(woff) !== "wOFF") throw new Error("WOFF dosyası değil.");
  const flavor = view.getUint32(4);
  const numTables = view.getUint16(12);
  if (numTables === 0 || 44 + numTables * 20 > woff.byteLength)
    throw new Error("WOFF tablo dizini bozuk.");
  const tables: {
    tag: number;
    offset: number;
    compLength: number;
    origLength: number;
    checksum: number;
  }[] = [];
  let total = 12 + numTables * 16;
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const t = {
      tag: view.getUint32(at),
      offset: view.getUint32(at + 4),
      compLength: view.getUint32(at + 8),
      origLength: view.getUint32(at + 12),
      checksum: view.getUint32(at + 16),
    };
    if (t.offset + t.compLength > woff.byteLength || t.compLength > t.origLength)
      throw new Error("WOFF tablosu dosyanın dışına taşıyor.");
    total += (t.origLength + 3) & ~3;
    if (total > MAX_SFNT_BYTES) throw new Error("WOFF çok büyük.");
    tables.push(t);
  }
  // Tables' data in the order it came (as in the original sfnt); the directory sorted by tag.
  const entries = await Promise.all(
    tables.map(async (t) => {
      const raw = woff.subarray(t.offset, t.offset + t.compLength);
      const bytes = t.compLength < t.origLength ? await inflate(raw) : raw;
      if (bytes.byteLength !== t.origLength) throw new Error("WOFF tablosu açılamadı.");
      return { ...t, bytes, at: 0 };
    }),
  );
  const out = new Uint8Array(total);
  const o = new DataView(out.buffer);
  let pow = 1;
  while (pow * 2 <= numTables) pow *= 2;
  o.setUint32(0, flavor);
  o.setUint16(4, numTables);
  o.setUint16(6, pow * 16);
  o.setUint16(8, Math.log2(pow));
  o.setUint16(10, numTables * 16 - pow * 16);
  let at = 12 + numTables * 16;
  for (const e of [...entries].sort((a, b) => a.offset - b.offset)) {
    e.at = at;
    out.set(e.bytes, at);
    at += (e.origLength + 3) & ~3;
  }
  [...entries]
    .sort((a, b) => a.tag - b.tag)
    .forEach((e, k) => {
      const rec = 12 + k * 16;
      o.setUint32(rec, e.tag);
      o.setUint32(rec + 4, e.checksum);
      o.setUint32(rec + 8, e.at);
      o.setUint32(rec + 12, e.origLength);
    });
  return out;
}

let woff2: Promise<(bytes: Uint8Array) => Promise<Uint8Array>> | null = null;

/** WOFF2 → sfnt (Google's decoder; its WebAssembly is loaded once, on first use). */
export async function woff2ToSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  woff2 ??= import("woff2-encoder/decompress").then(
    (m) => m.default,
    (e: unknown) => {
      woff2 = null;
      throw e;
    },
  );
  const decompress = await woff2;
  const out = await decompress(bytes);
  if (fontFileFormat(out) !== "sfnt") throw new Error("WOFF2 açılamadı.");
  return out;
}

/** The bytes as an sfnt font Wecra's engine reads (WOFF / WOFF2 decoded; others as they are). */
export async function toSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  switch (fontFileFormat(bytes)) {
    case "woff":
      return woffToSfnt(bytes);
    case "woff2":
      return woff2ToSfnt(bytes);
    default:
      return bytes;
  }
}
