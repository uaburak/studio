/**
 * "Kontrol yapay zekâda" (docs/URETIM-RESIM.md §9): a generated product picture is checked like
 * a client checks a professional product photographer's delivery — the setting, light and
 * framing may change, the product may not. The label text is compared deterministically (Apple
 * Vision OCR of the picture against the references' verbatim lines); a vision model compares the
 * rest (logo, shape and proportions, cap, colours, pattern / texture, added or missing elements,
 * realism). The report names exactly what is wrong, in Turkish. It is only a report: nothing is
 * generated again without the owner.
 */
import type { ApprovalCheckItem, ApprovalCheckReport } from "@studio/contract";
import type { Logger } from "../log.ts";
import type { VisionHelper } from "../vision/helper.ts";
import { removeDir, visionWorkDir, writeUpright } from "./compose.ts";
import { labelTokens, normalizeLabelText, tokenSimilarity } from "./label-check.ts";
import { ocrReadingOrder, type ReferenceDescription } from "./product-description.ts";
import { modelPicture, type VisionModelCaller } from "./vision-model.ts";

export const CHECK_ASPECTS = [
  "Etiket yazısı",
  "Logo",
  "Şekil ve oranlar",
  "Kapak",
  "Renkler",
  "Desen ve doku",
  "Eklenen ya da eksik öğe",
  "Gerçekçilik ve kalite",
] as const;
export type CheckAspect = (typeof CHECK_ASPECTS)[number];

const LABEL_ASPECT: CheckAspect = "Etiket yazısı";

// --- deterministic label text -------------------------------------------------------------------

export interface LabelFinding {
  expected: string;
  /** The closest line read on the picture (null: nothing like it). */
  found: string | null;
  /** `changed`: a line like it reads differently; `missing`: not read at all. */
  kind: "changed" | "missing";
}

/** Below this a found line is not "the same line, changed". */
const CHANGED_MIN = 0.5;

/**
 * Every expected line against what OCR read on the picture. A line is right when all of its
 * words are read exactly (case aside; Turkish letters and numbers count). Otherwise the closest
 * line read is reported as its changed form, or the line as missing.
 */
export function compareLabelLines(
  expected: readonly string[],
  found: readonly string[],
): { ok: string[]; findings: LabelFinding[] } {
  const foundTokens = new Set(found.flatMap(labelTokens));
  const foundNorm = found.map((f) => ({ raw: f.trim(), norm: normalizeLabelText(f) }));
  const ok: string[] = [];
  const findings: LabelFinding[] = [];
  for (const line of expected) {
    const tokens = labelTokens(line);
    if (tokens.length === 0) continue;
    if (tokens.every((t) => foundTokens.has(t))) {
      ok.push(line);
      continue;
    }
    const norm = normalizeLabelText(line);
    let best: { raw: string; score: number } | null = null;
    for (const f of foundNorm) {
      if (!f.norm) continue;
      const score = tokenSimilarity(norm, f.norm);
      if (!best || score > best.score) best = { raw: f.raw, score };
    }
    findings.push(
      best && best.score >= CHANGED_MIN
        ? { expected: line, found: best.raw, kind: "changed" }
        : { expected: line, found: null, kind: "missing" },
    );
  }
  return { ok, findings };
}

/** "'Bor %11' yazısı 'Bor %1' olmuş". */
export function findingNote(f: LabelFinding): string {
  return f.kind === "changed"
    ? `'${f.expected}' yazısı '${f.found}' olmuş`
    : `'${f.expected}' yazısı görselde okunamadı`;
}

// --- the report ---------------------------------------------------------------------------------

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function aspectKey(text: string): string {
  return text.trim().toLocaleLowerCase("tr-TR");
}

/** "Şu kısımlar hatalı geldi: etiket yazısı ('Bor %11' yazısı 'Bor %1' olmuş); kapak (…)". */
export function reportSummary(items: readonly ApprovalCheckItem[]): string {
  const failing = items.filter((i) => !i.ok);
  if (failing.length === 0) {
    return "Kontrol temiz: ürün referans fotoğraflarıyla birebir aynı; yalnızca sahne, ışık ve kadraj değişmiş.";
  }
  return clip(
    `Şu kısımlar hatalı geldi: ${failing
      .map((i) => `${aspectKey(i.aspect)}${i.note ? ` (${i.note})` : ""}`)
      .join("; ")}.`,
    2_000,
  );
}

/**
 * The report from the model's answer and the OCR comparison. Every aspect is listed; one the
 * model did not judge counts as not checked (not passed). A label line read differently fails
 * the label whatever the model said; lines OCR could not find are left to the model (they may be
 * on a side the picture does not show), unless there is no model.
 */
export function shapeCheckReport(input: {
  model: { items?: unknown; summary?: unknown } | null;
  modelError?: string | undefined;
  label: { findings: readonly LabelFinding[]; expected: number; ocr: boolean } | null;
}): ApprovalCheckReport {
  const fromModel = new Map<string, { ok: boolean; note: string }>();
  if (input.model && Array.isArray(input.model.items)) {
    for (const raw of input.model.items) {
      const r = raw as { aspect?: unknown; ok?: unknown; note?: unknown };
      if (typeof r.aspect !== "string") continue;
      const key = aspectKey(r.aspect);
      if (fromModel.has(key)) continue;
      fromModel.set(key, {
        ok: r.ok === true,
        note: typeof r.note === "string" ? r.note.trim() : "",
      });
    }
  }

  if (!input.model) {
    const items: ApprovalCheckItem[] = [];
    const reason = input.modelError
      ? `Yapay zekâ kontrolü yapılamadı (${clip(input.modelError, 300)}); ürünü elle karşılaştırın.`
      : "Görseli okuyabilen bir yapay zekâ modeli yok (Gemini anahtarı ya da Claude girişi gerekli); ürünü elle karşılaştırın.";
    if (input.label?.ocr && input.label.expected > 0) {
      const notes = input.label.findings.map(findingNote);
      items.push({
        aspect: LABEL_ASPECT,
        ok: input.label.findings.length === 0,
        note: clip(
          notes.length > 0
            ? `${notes.join("; ")} (görünmeyen yüzdeki satırlar da olabilir)`
            : "Etiketteki bütün satırlar görselde aynen okundu.",
          1_000,
        ),
      });
    }
    items.push({ aspect: "Görsel kontrol", ok: false, note: clip(reason, 1_000) });
    return { passed: false, items, summary: reportSummary(items) };
  }

  const items: ApprovalCheckItem[] = CHECK_ASPECTS.map((aspect) => {
    const m = fromModel.get(aspectKey(aspect));
    const item: ApprovalCheckItem = m
      ? { aspect, ok: m.ok, note: m.ok && !m.note ? "" : m.note || "Hatalı (ayrıntı yok)." }
      : { aspect, ok: false, note: "Kontrol bu başlığı değerlendirmedi; elle bakın." };
    if (aspect === LABEL_ASPECT && input.label?.ocr) {
      const changed = input.label.findings.filter((f) => f.kind === "changed");
      if (changed.length > 0) {
        // OCR misreads small and stylised lettering (a logo's "MTM AGRO" read as "ITM AGRE" on
        // the reference itself): a line without numbers that the model, looking at both
        // pictures, sees unchanged is shown for a look, not counted as a fault. A changed
        // number ("Bor %11" → "Bor %1") always fails: the model can miss it, OCR reads digits well.
        const soft = m?.ok ? changed.filter((f) => !/\d/.test(f.expected)) : [];
        const hard = changed.filter((f) => !soft.includes(f));
        const notes = hard.map(findingNote);
        if (hard.length > 0) {
          item.ok = false;
          item.note = [...notes, item.note && !m?.ok ? item.note : ""].filter(Boolean).join("; ");
        }
        if (soft.length > 0) {
          const look = `OCR şu satırları farklı okudu (yapay zekâ aynı gördü), elle bak: ${soft.map(findingNote).join("; ")}`;
          item.note = [item.note, look].filter(Boolean).join("; ");
        }
      }
    }
    item.note = clip(item.note, 1_000);
    return item;
  });
  return {
    passed: items.every((i) => i.ok),
    items,
    summary: reportSummary(items),
  };
}

// --- running it ---------------------------------------------------------------------------------

export interface VerifyDeps {
  vision: VisionHelper;
  stateDir: string;
  logger: Logger;
  model: VisionModelCaller | null;
}

export interface VerifyInput {
  generated: Uint8Array;
  references: readonly { bytes: Uint8Array; description: ReferenceDescription | null }[];
  products: readonly { name: string; category: string; description: string; notes: string }[];
  /** The label lines that must read the same (verbatim, from the references). */
  expectedLines: readonly string[];
  mode: "scene" | "upgrade";
}

const VERIFY_SYSTEM = `Sen titiz bir müşterisin. Ürününü profesyonel bir ürün fotoğrafçısına verdin; o çekip SON GÖRSEL'i teslim etti. SON GÖRSEL'i ürünün kendi fotoğraflarıyla (REFERANS) ve bilgileriyle karşılaştır.
Kural: ürün üzerinde HİÇBİR fiziksel değişikliğe izin yok. Kadraj, ortam, ambiyans, ışık ve fotoğraf kalitesi değişebilir; bunlar hata değildir.
Her başlığı ayrı değerlendir: ${CHECK_ASPECTS.map((a) => `"${a}"`).join(", ")}.
- "Etiket yazısı": görünen her satır referanstakiyle harfi harfine aynı mı (Türkçe karakterler, rakamlar, % gibi işaretler dahil)? Görselin göstermediği bir yüzdeki satırlar hata değildir.
- "Eklenen ya da eksik öğe": üründe olmayan bir yazı, etiket, ikon, ikinci ürün eklenmiş ya da üründeki bir öğe kaybolmuş mu?
- "Gerçekçilik ve kalite": gerçek bir ürün fotoğrafı gibi mi (yapay zekâ izleri, eriyen harfler, bozuk kenarlar, yanlış gölge, fiziksel olarak imkânsız yerleşim)?
Not alanı hatayı tam adıyla söylesin, ör. "arka etiketteki 'Bor %11' yazısı 'Bor %1' olmuş", "kapak beyaz yerine gri", "logodaki yaprak simgesi eksik". Doğru olan başlıkta not boş kalabilir. Emin olmadığın şeyi hata sayma ama görmediğini doğru da sayma. Türkçe yaz, yalnızca JSON döndür.`;

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          aspect: { type: "string", enum: [...CHECK_ASPECTS] },
          ok: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["aspect", "ok", "note"],
      },
    },
    summary: { type: "string" },
  },
  required: ["items", "summary"],
};

/** OCR of the generated picture (null: no helper, or it failed). */
async function readPicture(
  deps: VerifyDeps,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<string[] | null> {
  if (!(await deps.vision.available())) return null;
  const dir = await visionWorkDir(deps.stateDir);
  try {
    const file = await writeUpright(dir, "generated-check.png", bytes);
    const ocr = await deps.vision.ocr(file, { signal });
    return ocrReadingOrder(ocr.lines);
  } catch (error) {
    if (signal.aborted) throw error;
    deps.logger.warn(`check OCR failed: ${(error as Error).message}`);
    return null;
  } finally {
    await removeDir(dir);
  }
}

export async function verifyProductImage(
  deps: VerifyDeps,
  input: VerifyInput,
  signal: AbortSignal,
): Promise<ApprovalCheckReport> {
  const found = await readPicture(deps, input.generated, signal);
  const label = found
    ? {
        ...compareLabelLines(input.expectedLines, found),
        expected: input.expectedLines.length,
        ocr: true,
      }
    : null;

  if (!deps.model) {
    return shapeCheckReport({ model: null, label });
  }
  const content: Parameters<VisionModelCaller>[0]["content"] = [];
  content.push({
    type: "text",
    text: [
      input.mode === "upgrade"
        ? "İstenen: aynı ürünün beyaz zeminde, stüdyo ışığında, yüksek çözünürlüklü bir fotoğrafı."
        : "İstenen: aynı ürünün yeni bir sahnede fotoğrafı.",
      "Ürün bilgileri:",
      ...input.products.map(
        (p) =>
          `- ${p.name}${p.category ? ` (${p.category})` : ""}${p.description ? `: ${p.description}` : ""}${p.notes ? ` · Notlar: ${p.notes.slice(0, 500)}` : ""}`,
      ),
      "Etiketteki satırlar (referanslardan, harfi harfine):",
      ...(input.expectedLines.length > 0
        ? input.expectedLines.map((l) => `| ${l}`)
        : ["(okunur yazı yok)"]),
      label
        ? `Apple Vision SON GÖRSEL'de şunları okudu:\n${(found ?? []).map((l) => `| ${l}`).join("\n") || "(hiçbir yazı)"}\nOCR karşılaştırması: ${label.findings.length === 0 ? "bütün satırlar aynen okundu" : label.findings.map(findingNote).join("; ")}.`
        : "SON GÖRSEL OCR ile okunamadı; yazıları kendin oku.",
    ].join("\n"),
  });
  for (const [i, ref] of input.references.entries()) {
    const d = ref.description;
    content.push({
      type: "text",
      text: `REFERANS ${i + 1}${d?.view ? ` (${d.view})` : ""}${
        d && d.colors.length > 0
          ? ` · renkler: ${d.colors.map((c) => `${c.name} ${c.hex}`.trim()).join(", ")}`
          : ""
      }${d?.shape ? ` · şekil: ${d.shape}` : ""}${d?.closure ? ` · kapak: ${d.closure}` : ""}`,
    });
    content.push(await modelPicture(ref.bytes));
  }
  content.push({ type: "text", text: "SON GÖRSEL:" });
  content.push(await modelPicture(input.generated));

  try {
    const res = await deps.model({
      label: "verify product picture",
      system: VERIFY_SYSTEM,
      content,
      schema: VERIFY_SCHEMA,
      signal,
    });
    return shapeCheckReport({
      model: (res.output ?? {}) as { items?: unknown; summary?: unknown },
      label,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    deps.logger.warn(`product picture check failed: ${(error as Error).message}`);
    return shapeCheckReport({ model: null, modelError: (error as Error).message, label });
  }
}
