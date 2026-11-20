/**
 * "Birebir tarif" (docs/URETIM-RESIM.md §8): before a product picture is generated, every
 * reference photo is read — the label text verbatim (Apple Vision OCR: exact letters, Turkish
 * characters, order; the vision model fills in what OCR missed), brand and logo, colours with an
 * approximate hex, patterns, materials and textures, the container's shape and proportions, the
 * cap / closure, transparency and fill level. The description is cached per photo (asset id +
 * content hash), so a photo is read once.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrandProduct } from "@studio/contract";
import type { Logger } from "../log.ts";
import type { VisionHelper } from "../vision/helper.ts";
import { removeDir, visionWorkDir, writeUpright } from "./compose.ts";
import { normalizeLabelText, tokenSimilarity } from "./label-check.ts";
import { modelPicture, type VisionModelCaller } from "./vision-model.ts";

/** Bump when the description's shape or the reading changes (old cache entries are redone). */
export const DESCRIPTION_VERSION = 1;

export interface DescribedColor {
  name: string;
  /** Approximate, `#RRGGBB`. */
  hex: string;
  where: string;
}

export interface ReferenceDescription {
  version: number;
  assetId: string;
  /** sha256 of the photo's bytes (hex, first 32). */
  hash: string;
  /** Which side the photo shows ("ön", "arka", "sol yan"…), "" when unknown. */
  view: string;
  /** Every label line verbatim, top to bottom. */
  labelLines: string[];
  labelSource: "ocr" | "model" | "ocr+model" | "none";
  brand: string;
  logo: string;
  colors: DescribedColor[];
  patterns: string;
  materials: string;
  shape: string;
  proportions: string;
  closure: string;
  transparency: string;
  otherDetails: string;
  /** The vision model that read it (null: OCR only). */
  model: string | null;
  notes: string[];
}

export interface DescribeDeps {
  vision: VisionHelper;
  stateDir: string;
  logger: Logger;
  /** Null: no vision model can run (OCR only). */
  model: VisionModelCaller | null;
}

/** OCR lines below this confidence are not taken as label text. */
const MIN_OCR_CONFIDENCE = 0.4;
/** A model-read line this similar to an OCR line is the same line (OCR's spelling wins). */
const SAME_LINE = 0.75;

export function photoHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

function cacheFile(stateDir: string, assetId: string, hash: string): string {
  const safe = assetId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
  return path.join(stateDir, "product-descriptions", `${safe}-${hash}.json`);
}

export async function readCachedDescription(
  stateDir: string,
  assetId: string,
  hash: string,
): Promise<ReferenceDescription | null> {
  try {
    const parsed = JSON.parse(
      await readFile(cacheFile(stateDir, assetId, hash), "utf8"),
    ) as ReferenceDescription;
    return parsed.version === DESCRIPTION_VERSION && parsed.hash === hash ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCachedDescription(stateDir: string, d: ReferenceDescription): Promise<void> {
  const file = cacheFile(stateDir, d.assetId, d.hash);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(d), "utf8");
  await rename(tmp, file);
}

const DESCRIBE_SYSTEM = `Sen bir ürün fotoğrafının teknik tarifini çıkaran dikkatli bir uzmansın. Bu tarif, bir görsel modelinin ürünü hiçbir değişiklik yapmadan yeniden çizebilmesi için kullanılacak.
- Etiketteki ve ambalajdaki BÜTÜN yazıları harfi harfine, yukarıdan aşağıya okuma sırasıyla, her satır ayrı yaz. Türkçe karakterleri (ç, ğ, ı, İ, ö, ş, ü), büyük/küçük harfi, rakamları, %, ®, ™ gibi işaretleri aynen koru. Okuyamadığın harfi tahmin etme; satırı yazma. Çeviri yapma.
- Sana Apple Vision'ın okuduğu satırlar da verilir; onlar harf harf doğrudur. Senin görevin onlarda olmayan satırları da eklemek.
- Renkleri adıyla ve yaklaşık hex koduyla (#RRGGBB), nerede olduklarıyla yaz.
- Şekil, oranlar (ör. yükseklik/genişlik ≈ 2.5), kapak/kapama, şeffaflık ve doluluk, malzeme ve doku, desenler, logo (ne gösterdiği, rengi, yeri) ayrıntılı ve ölçülebilir olsun.
- Yalnızca görüneni yaz; emin olmadığın şeyi yazma. Yalnızca JSON döndür.`;

const DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    view: {
      type: "string",
      description: "Fotoğraf ürünün hangi yüzünü gösteriyor (ön, arka, sol yan…).",
    },
    labelLines: {
      type: "array",
      items: { type: "string" },
      description: "Etiketteki bütün yazılar, harfi harfine, okuma sırasıyla, satır satır.",
    },
    brand: { type: "string" },
    logo: { type: "string" },
    colors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          hex: { type: "string" },
          where: { type: "string" },
        },
        required: ["name", "hex", "where"],
      },
    },
    patterns: { type: "string" },
    materials: { type: "string" },
    shape: { type: "string" },
    proportions: { type: "string" },
    closure: { type: "string" },
    transparency: { type: "string" },
    otherDetails: { type: "string" },
  },
  required: [
    "view",
    "labelLines",
    "brand",
    "logo",
    "colors",
    "patterns",
    "materials",
    "shape",
    "proportions",
    "closure",
    "transparency",
    "otherDetails",
  ],
};

const str = (v: unknown, max = 1_000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function hexOf(v: unknown): string {
  const s = str(v, 16).toUpperCase();
  const m = /^#?([0-9A-F]{6})$/.exec(s) ?? /^#?([0-9A-F]{3})$/.exec(s);
  if (!m?.[1]) return "";
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h}`;
}

/** OCR lines in reading order (top to bottom, then left to right). */
export function ocrReadingOrder(
  lines: readonly {
    text: string;
    confidence: number;
    box: { x: number; y: number; height: number };
  }[],
): string[] {
  return [...lines]
    .filter((l) => l.confidence >= MIN_OCR_CONFIDENCE && l.text.trim())
    .sort((a, b) => {
      const rowGap = Math.min(a.box.height, b.box.height) / 2;
      return Math.abs(a.box.y - b.box.y) > rowGap ? a.box.y - b.box.y : a.box.x - b.box.x;
    })
    .map((l) => l.text.trim());
}

/**
 * OCR lines are exact; the model's lines that OCR did not read are added after them (a
 * model line close to an OCR line is that line, in OCR's spelling).
 */
export function mergeLabelLines(
  ocr: readonly string[],
  model: readonly string[],
): { lines: string[]; source: ReferenceDescription["labelSource"] } {
  const lines = [...ocr];
  let added = 0;
  for (const m of model) {
    const norm = normalizeLabelText(m);
    if (!norm) continue;
    const known = lines.some((l) => {
      const n = normalizeLabelText(l);
      return n === norm || n.includes(norm) || tokenSimilarity(n, norm) >= SAME_LINE;
    });
    if (!known) {
      lines.push(m.trim());
      added++;
    }
  }
  const source =
    ocr.length > 0 ? (added > 0 ? "ocr+model" : "ocr") : lines.length > 0 ? "model" : "none";
  return { lines: lines.slice(0, 80), source };
}

/** Read one reference photo (cached by asset id + content hash). */
export async function describeReference(
  deps: DescribeDeps,
  input: { assetId: string; bytes: Uint8Array; productName?: string },
  options: { signal?: AbortSignal } = {},
): Promise<ReferenceDescription> {
  const hash = photoHash(input.bytes);
  const cached = await readCachedDescription(deps.stateDir, input.assetId, hash);
  if (cached) return cached;
  const signal = options.signal;
  const notes: string[] = [];

  let ocrLines: string[] = [];
  let ocrRan = false;
  if (await deps.vision.available()) {
    const dir = await visionWorkDir(deps.stateDir);
    try {
      const file = await writeUpright(dir, "reference-describe.png", input.bytes);
      const ocr = await deps.vision.ocr(file, signal ? { signal } : {});
      ocrLines = ocrReadingOrder(ocr.lines);
      ocrRan = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      notes.push(`Etiket OCR ile okunamadı (${(error as Error).message}).`);
    } finally {
      await removeDir(dir);
    }
  } else {
    notes.push("Apple Vision yok: etiket yazısı yalnızca yapay zekâyla okundu.");
  }

  let out: Record<string, unknown> = {};
  let model: string | null = null;
  if (deps.model) {
    try {
      const res = await deps.model({
        label: `describe ${input.assetId}`,
        system: DESCRIBE_SYSTEM,
        content: [
          {
            type: "text",
            text: `Ürün: ${input.productName ?? "bilinmiyor"}\nApple Vision'ın okuduğu satırlar (düz yazıda harf harf doğru; küçük ve stilize logo yazılarında yanılabilir — görselde gerçekte ne yazıyorsa onu yaz):\n${ocrLines.length > 0 ? ocrLines.map((l) => `| ${l}`).join("\n") : "(okunamadı)"}`,
          },
          await modelPicture(input.bytes),
        ],
        schema: DESCRIBE_SCHEMA,
        signal: signal ?? new AbortController().signal,
      });
      out = (res.output ?? {}) as Record<string, unknown>;
      model = res.model;
    } catch (error) {
      if (signal?.aborted) throw error;
      notes.push(`Ürün fotoğrafı yapay zekâyla okunamadı (${(error as Error).message}).`);
    }
  } else {
    notes.push("Görsel okuyabilen bir yapay zekâ modeli yok: renk, şekil ve doku tarif edilemedi.");
  }

  const modelLines = Array.isArray(out.labelLines)
    ? out.labelLines.map((l) => str(l, 300)).filter(Boolean)
    : [];
  const label = mergeLabelLines(ocrLines, modelLines);
  const colors = Array.isArray(out.colors)
    ? out.colors
        .map((c) => c as Record<string, unknown>)
        .map((c) => ({ name: str(c.name, 60), hex: hexOf(c.hex), where: str(c.where, 200) }))
        .filter((c) => c.name || c.hex)
        .slice(0, 12)
    : [];
  const description: ReferenceDescription = {
    version: DESCRIPTION_VERSION,
    assetId: input.assetId,
    hash,
    view: str(out.view, 80),
    labelLines: label.lines,
    labelSource: label.source,
    brand: str(out.brand, 200),
    logo: str(out.logo, 500),
    colors,
    patterns: str(out.patterns),
    materials: str(out.materials),
    shape: str(out.shape),
    proportions: str(out.proportions, 500),
    closure: str(out.closure, 500),
    transparency: str(out.transparency, 500),
    otherDetails: str(out.otherDetails),
    model,
    notes,
  };
  // Only a complete reading is kept: a failed model (or OCR) call is tried again next time.
  if (model && (ocrRan || !(await deps.vision.available()))) {
    await writeCachedDescription(deps.stateDir, description).catch((error: unknown) =>
      deps.logger.warn(`could not cache the product description: ${(error as Error).message}`),
    );
  }
  return description;
}

/** Every label line of the references, once each, in order. */
export function expectedLabelLines(descriptions: readonly ReferenceDescription[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of descriptions) {
    for (const l of d.labelLines) {
      const key = normalizeLabelText(l);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
  }
  return out;
}

const line = (label: string, value: string) => (value ? `- ${label}: ${value}` : "");

/** The exact description of one product for the image prompt (English frame, text verbatim). */
export function formatProductDescription(
  product: Pick<BrandProduct, "name" | "category" | "description">,
  descriptions: readonly ReferenceDescription[],
  index = 1,
): string {
  const head = [
    `PRODUCT ${index}: "${product.name}"`,
    product.category ? `(category: ${product.category})` : "",
    product.description ? `— ${product.description}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const blocks = descriptions.map((d, i) => {
    const label =
      d.labelLines.length > 0
        ? [
            "- Label text, verbatim, in this exact order (every letter, Turkish character, number, symbol and line break exactly as written; never translate, correct or rearrange):",
            ...d.labelLines.map((l) => `    | ${l}`),
          ].join("\n")
        : "- Label text: none readable on this photo (do not invent any).";
    const colors =
      d.colors.length > 0
        ? d.colors
            .map((c) => `${c.name}${c.hex ? ` (${c.hex})` : ""}${c.where ? ` — ${c.where}` : ""}`)
            .join("; ")
        : "";
    return [
      `Reference photo ${i + 1}${d.view ? ` (view: ${d.view})` : ""}:`,
      label,
      line("Brand", d.brand),
      line("Logo", d.logo),
      line("Colours (approximate hex)", colors),
      line("Patterns", d.patterns),
      line("Materials and textures", d.materials),
      line("Container shape", d.shape),
      line("Proportions", d.proportions),
      line("Cap / closure", d.closure),
      line("Transparency / fill level", d.transparency),
      line("Other details", d.otherDetails),
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [head, ...blocks].join("\n");
}
