/**
 * Label verification for product composites (U9, `.claude/skills/product-reference-image`):
 * read the label on the reference first, then read it again on the final picture and compare
 * line by line. Never report a label as right without having read it.
 *
 * - A-class lines (must match): what reads at a normal look on the reference — confident OCR lines
 *   whose letters are not tiny next to the product — or every line the owner typed (`labelText`).
 * - B-class (fine print): not required; noted only.
 * Matching is Turkish-aware: case folds with tr-TR, a lost or added diacritic (ş/s, ı/i, ğ/g …)
 * costs half a letter, and any token with digits (dose, weight, phone, licence numbers) must
 * match exactly.
 */
import type { Box, OcrLine } from "../vision/helper.ts";

export type LabelCheckStatus = "ok" | "mismatch" | "unreadable" | "no_label" | "skipped";

export interface LabelCheck {
  status: LabelCheckStatus;
  /** Where the expected text came from. */
  source: "owner" | "ocr" | "none";
  /** A-class lines that must read the same on the final picture. */
  expected: string[];
  /** Fine print seen on the reference (not required). */
  finePrint: string[];
  /** What was read on the final picture's product area. */
  found: string[];
  /** Expected lines that were not found, or read differently. */
  missing: string[];
  /** Share of the expected letters found (0…1). */
  score: number;
  /** Turkish, for the owner. */
  message: string;
}

/** OCR confidence and relative letter height an A-class line needs. */
const A_MIN_CONFIDENCE = 0.5;
const A_MIN_HEIGHT = 0.022;
/** A line passes when this share of its words is found (and every number is). */
const LINE_PASS = 0.75;
/** A word is found when this similar to one read on the final picture. */
const WORD_PASS = 0.8;

const DIACRITIC_PAIRS = new Map<string, string>([
  ["ı", "i"],
  ["ş", "s"],
  ["ç", "c"],
  ["ğ", "g"],
  ["ü", "u"],
  ["ö", "o"],
  ["â", "a"],
  ["î", "i"],
  ["û", "u"],
]);

function base(ch: string): string {
  return DIACRITIC_PAIRS.get(ch) ?? ch;
}

/**
 * tr-TR lowercase, NFC, punctuation to spaces, numbers apart from letters ("25KG" → "25 kg", as
 * OCR glues or splits units either way), single spaces.
 */
export function normalizeLabelText(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("tr-TR")
    .replace(/i̇/g, "i")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/(\p{N})(?=\p{L})|(\p{L})(?=\p{N})/gu, "$1$2 ")
    .replace(/\s+/g, " ")
    .trim();
}

export function labelTokens(text: string): string[] {
  const norm = normalizeLabelText(text);
  return norm ? norm.split(" ") : [];
}

/** Edit distance where a diacritic-only difference (ş ↔ s …) costs 0.5. */
export function turkishDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const prev = new Array<number>(y.length + 1);
  const cur = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const ci = x[i - 1] as string;
      const cj = y[j - 1] as string;
      const sub = ci === cj ? 0 : base(ci) === base(cj) ? 0.5 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + sub,
      );
    }
    for (let j = 0; j <= y.length; j++) prev[j] = cur[j] as number;
  }
  return prev[y.length] as number;
}

export function tokenSimilarity(a: string, b: string): number {
  const len = Math.max([...a].length, [...b].length);
  if (len === 0) return 1;
  return 1 - turkishDistance(a, b) / len;
}

const hasDigit = (t: string) => /\p{N}/u.test(t);

/** Does one expected line read on the final picture? */
export function lineMatch(
  expected: string,
  foundTokens: readonly string[],
  foundCompact: string,
): { score: number; ok: boolean; letters: number; matchedLetters: number } {
  const tokens = labelTokens(expected).filter((t) => hasDigit(t) || [...t].length >= 2);
  if (tokens.length === 0) return { score: 1, ok: true, letters: 0, matchedLetters: 0 };
  let matched = 0;
  let letters = 0;
  let matchedLetters = 0;
  let numbersOk = true;
  for (const token of tokens) {
    const size = [...token].length;
    letters += size;
    let ok: boolean;
    if (hasDigit(token)) {
      // Numbers must be exact; OCR may glue "25 kg" into "25kg".
      ok = foundTokens.includes(token) || foundCompact.includes(token);
      if (!ok) numbersOk = false;
    } else {
      let best = 0;
      for (const f of foundTokens) {
        const s = tokenSimilarity(token, f);
        if (s > best) best = s;
        if (best === 1) break;
      }
      ok = size <= 3 ? best >= 0.83 : best >= WORD_PASS;
    }
    if (ok) {
      matched++;
      matchedLetters += size;
    }
  }
  const score = matched / tokens.length;
  return { score, ok: numbersOk && score >= LINE_PASS, letters, matchedLetters };
}

/**
 * The label to verify, from the reference's OCR: lines whose centre is inside the product (the
 * cutout's box on the reference), split into A-class and fine print.
 */
export function expectedFromReference(
  lines: readonly OcrLine[],
  productBox: Box | null,
): { expected: string[]; finePrint: string[] } {
  const box = productBox ?? { x: 0, y: 0, width: 1, height: 1 };
  const expected: string[] = [];
  const finePrint: string[] = [];
  for (const line of lines) {
    const cx = line.box.x + line.box.width / 2;
    const cy = line.box.y + line.box.height / 2;
    if (cx < box.x || cx > box.x + box.width || cy < box.y || cy > box.y + box.height) continue;
    if (labelTokens(line.text).length === 0) continue;
    const relHeight = line.box.height / Math.max(0.01, box.height);
    if (line.confidence >= A_MIN_CONFIDENCE && relHeight >= A_MIN_HEIGHT) expected.push(line.text);
    else finePrint.push(line.text);
  }
  return { expected, finePrint };
}

/** The owner's own label text: every non-empty line is A-class. */
export function expectedFromOwner(labelText: string): string[] {
  return labelText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => labelTokens(l).length > 0)
    .slice(0, 60);
}

export function compareLabel(input: {
  expected: readonly string[];
  finePrint?: readonly string[];
  source: "owner" | "ocr";
  found: readonly string[];
}): LabelCheck {
  const expected = [...input.expected];
  const finePrint = [...(input.finePrint ?? [])];
  const found = [...input.found];
  if (expected.length === 0) {
    return {
      status: "no_label",
      source: "none",
      expected,
      finePrint,
      found,
      missing: [],
      score: 0,
      message:
        "Referans fotoğrafta okunur etiket yazısı bulunamadı; etiket doğrulanamadı. Etiket metni varsa onu verin (labelText).",
    };
  }
  const foundTokens = found.flatMap(labelTokens);
  const foundCompact = foundTokens.join("");
  let letters = 0;
  let matchedLetters = 0;
  const missing: string[] = [];
  for (const line of expected) {
    const m = lineMatch(line, foundTokens, foundCompact);
    letters += m.letters;
    matchedLetters += m.matchedLetters;
    if (!m.ok) missing.push(line);
  }
  const score = letters === 0 ? 1 : matchedLetters / letters;
  const rounded = Math.round(score * 1000) / 1000;
  const fine = finePrint.length > 0 ? " İnce yazılar birebir aranmadı; yakından kontrol edin." : "";
  if (foundTokens.length === 0 || score < 0.3) {
    return {
      status: "unreadable",
      source: input.source,
      expected,
      finePrint,
      found,
      missing,
      score: rounded,
      message:
        "Son görselde ürün etiketi okunamıyor (ürün küçük, kesik ya da bulanık olabilir). Görseli kontrol etmeden kullanmayın.",
    };
  }
  if (missing.length > 0) {
    const list = missing
      .slice(0, 5)
      .map((l) => `“${l}”`)
      .join(", ");
    return {
      status: "mismatch",
      source: input.source,
      expected,
      finePrint,
      found,
      missing,
      score: rounded,
      message: `Etiketteki ${missing.length} satır son görselde okunamadı ya da farklı: ${list}. Görseli kontrol etmeden kullanmayın.`,
    };
  }
  return {
    status: "ok",
    source: input.source,
    expected,
    finePrint,
    found,
    missing,
    score: rounded,
    message: `Etiket doğrulandı: ${expected.length} satırın hepsi son görselde aynen okundu.${fine}`,
  };
}

/** No helper: the label could not be read, so it is not called right. */
export function skippedLabelCheck(reason: string): LabelCheck {
  return {
    status: "skipped",
    source: "none",
    expected: [],
    finePrint: [],
    found: [],
    missing: [],
    score: 0,
    message: `Etiket doğrulanamadı: ${reason} Gerçek ürün fotoğrafı piksel piksel yapıştırıldı ama sonuç okunarak kontrol edilmedi.`,
  };
}
