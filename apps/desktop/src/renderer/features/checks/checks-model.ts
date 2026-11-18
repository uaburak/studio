// Generation checks ("Kontroller", roadmap 13) as the post detail and the brand settings show
// them: labels, the order of the list, the summary line, what "Düzelt" can fix, the approval
// warning, and the settings draft. No React, no API (tested in test/renderer/checks.test.ts).
import {
  approvalBlockers,
  type BrandCheckSettings,
  type BrandCheckSettingsPut,
  CHECK_CATALOG,
  CHECK_CATEGORIES,
  type CheckId,
  type CheckRef,
  type CheckStatus,
  type ContentCheckResult,
  type ContentCheckRun,
  checkCategoryOf,
  checksByCategory,
  isCheckId,
  MAX_BANNED_WORDS,
  sortCheckResults,
} from "@studio/contract";
import type { TagTone } from "../../components/ui/controls.tsx";

export const STATUS_LABEL: Record<CheckStatus, string> = {
  fail: "Başarısız",
  warn: "Uyarı",
  fixed: "Düzeltildi",
  pass: "Geçti",
  skipped: "Atlandı",
};

export const STATUS_TONE: Record<CheckStatus, TagTone> = {
  fail: "danger",
  warn: "warning",
  fixed: "accent",
  pass: "success",
  skipped: "neutral",
};

// Turkish case endings after a number as it is read: "v3'te", "v2'de", "v6'dan".
const LAST_WORD_HARD: Record<number, boolean> = {
  1: false, // bir
  2: false, // iki
  3: true, // üç
  4: true, // dört
  5: true, // beş
  6: false, // altı
  7: false, // yedi
  8: false, // sekiz
  9: false, // dokuz
};
const LAST_WORD_BACK: Record<number, boolean> = {
  1: false,
  2: false,
  3: false,
  4: false,
  5: false,
  6: true,
  7: false,
  8: false,
  9: true,
};
// Tens / powers when the number ends in zero: on, yirmi, otuz, kırk, elli, altmış, yetmiş, seksen, doksan.
const TENS: Record<number, { hard: boolean; back: boolean }> = {
  1: { hard: false, back: true },
  2: { hard: false, back: false },
  3: { hard: false, back: true },
  4: { hard: true, back: true },
  5: { hard: false, back: false },
  6: { hard: true, back: true },
  7: { hard: true, back: false },
  8: { hard: false, back: false },
  9: { hard: false, back: true },
};

function numberSound(n: number): { hard: boolean; back: boolean } {
  const digit = n % 10;
  if (digit !== 0)
    return { hard: LAST_WORD_HARD[digit] ?? false, back: LAST_WORD_BACK[digit] ?? false };
  const tens = Math.floor(n / 10) % 10;
  if (tens !== 0) return TENS[tens] ?? { hard: false, back: false };
  // yüz, bin, milyon → front vowels, soft ending except "yüz" (z).
  return { hard: false, back: false };
}

/** "v3'te", "v2'de", "v6'da" */
export function inVersion(n: number): string {
  const { hard, back } = numberSound(n);
  return `v${n}'${hard ? "t" : "d"}${back ? "a" : "e"}`;
}

/** "v3'ten", "v2'den", "v6'dan" */
export function fromVersion(n: number): string {
  return `${inVersion(n)}n`;
}

/** "Metin taşması" (an unknown id from a newer worker: the id itself). */
export function checkLabel(id: string): string {
  return isCheckId(id) ? CHECK_CATALOG[id].label : id;
}

/** "Yerleşim" */
export function categoryLabel(id: string): string {
  return CHECK_CATEGORIES[checkCategoryOf(id)].label;
}

/** "Slayt 2 · headline", "Slayt 1", "Açıklama". */
export function refLabel(refs: readonly CheckRef[]): string | null {
  const ref = refs[0];
  if (!ref) return null;
  if (ref.slide === null) return ref.layer;
  return ref.layer ? `Slayt ${ref.slide + 1} · ${ref.layer}` : `Slayt ${ref.slide + 1}`;
}

/** Where a finding sits when it is not on a slide (caption checks). */
export function placeLabel(result: Pick<ContentCheckResult, "refs" | "checkId">): string | null {
  const onSlide = refLabel(result.refs);
  if (onSlide) return onSlide;
  if (result.checkId.startsWith("text.")) return "Açıklama";
  if (result.checkId.startsWith("brief.")) return "Brief";
  return null;
}

export interface CheckListView {
  /** Fail, warn, fixed (in that order), shown open. */
  problems: ContentCheckResult[];
  /** Passes and skips, folded under one row. */
  rest: ContentCheckResult[];
  passed: number;
  skipped: number;
}

export function listView(run: Pick<ContentCheckRun, "results">): CheckListView {
  const sorted = sortCheckResults(run.results);
  const problems = sorted.filter(
    (r) => r.status === "fail" || r.status === "warn" || r.status === "fixed",
  );
  const rest = sorted.filter((r) => r.status === "pass" || r.status === "skipped");
  return {
    problems,
    rest,
    passed: rest.filter((r) => r.status === "pass").length,
    skipped: rest.filter((r) => r.status === "skipped").length,
  };
}

/** "2 başarısız · 1 uyarı · 14 geçti" (only the non-zero parts; "Hepsi geçti" when clean). */
export function summaryText(run: Pick<ContentCheckRun, "summary">): string {
  const s = run.summary;
  const parts = [
    s.fail ? `${s.fail} başarısız` : "",
    s.warn ? `${s.warn} uyarı` : "",
    s.fixed ? `${s.fixed} düzeltildi` : "",
    s.pass ? `${s.pass} geçti` : "",
    s.skipped ? `${s.skipped} atlandı` : "",
  ].filter(Boolean);
  if (!s.fail && !s.warn && s.pass > 0) return `Hepsi geçti · ${parts.join(" · ")}`;
  return parts.join(" · ") || "Kontrol yok";
}

/** Worst status of the run (the header icon). */
export function overallStatus(run: Pick<ContentCheckRun, "summary">): CheckStatus {
  const s = run.summary;
  if (s.fail) return "fail";
  if (s.warn) return "warn";
  if (s.fixed) return "fixed";
  if (s.pass) return "pass";
  return "skipped";
}

/** Checks whose open findings "Düzelt" can fix. */
export function fixableChecks(run: Pick<ContentCheckRun, "results">): CheckId[] {
  const ids = new Set<CheckId>();
  for (const r of run.results) {
    if (r.fixable && (r.status === "fail" || r.status === "warn") && isCheckId(r.checkId)) {
      ids.add(r.checkId);
    }
  }
  return [...ids];
}

export interface ApprovalWarning {
  blocking: number;
  title: string;
  /** Up to five problems: "Metin taşması: … " */
  lines: string[];
}

/**
 * The warning the approve button shows first, or null when the version may be approved. With the
 * brand's settings the run is judged as the API judges it now (switched-off checks left out, the
 * current strictness: `approvalBlockers`); without them by the run's own count.
 */
export function approvalWarning(
  run: Pick<ContentCheckRun, "blocking" | "results" | "strictness" | "version"> | null | undefined,
  settings?: Pick<BrandCheckSettings, "disabledChecks" | "strictness"> | null,
): ApprovalWarning | null {
  if (!run) return null;
  const blocking = settings
    ? approvalBlockers(run.results, settings)
    : run.blocking > 0
      ? run.results.filter(
          (r) => r.status === "fail" || (run.strictness === "strict" && r.status === "warn"),
        )
      : [];
  const count = settings ? blocking.length : run.blocking;
  if (count <= 0) return null;
  return {
    blocking: count,
    title: `${inVersion(run.version)} ${count} kontrol geçmedi`,
    lines: sortCheckResults(blocking)
      .slice(0, 5)
      .map((r) => `${checkLabel(r.checkId)}: ${r.message}`),
  };
}

/** Failures of a run as the tab's badge counts them (the brand's switched-off checks left out). */
export function failureCount(
  run: Pick<ContentCheckRun, "results"> | null | undefined,
  settings?: Pick<BrandCheckSettings, "disabledChecks"> | null,
): number {
  if (!run) return 0;
  const off = new Set(settings?.disabledChecks ?? []);
  return run.results.filter((r) => r.status === "fail" && !off.has(r.checkId)).length;
}

// --- brand settings ----------------------------------------------------------------------------

export const STRICTNESS_OPTIONS: {
  value: BrandCheckSettings["strictness"];
  label: string;
  detail: string;
}[] = [
  {
    value: "relaxed",
    label: "Esnek",
    detail: "Kozmetik uyarılar gizlenir; dil ve marka bulguları yalnızca uyarıdır.",
  },
  {
    value: "standard",
    label: "Standart",
    detail: "Başarısız kontroller onaydan önce sorulur, uyarılar listede kalır.",
  },
  {
    value: "strict",
    label: "Sıkı",
    detail: "Uyarılar da onaydan önce sorulur.",
  },
];

export interface SettingsDraft {
  disabled: Set<CheckId>;
  bannedWords: string[];
  strictness: BrandCheckSettings["strictness"];
  autoFix: boolean;
}

export function settingsDraft(s: BrandCheckSettings): SettingsDraft {
  return {
    disabled: new Set(s.disabledChecks.filter(isCheckId)),
    bannedWords: [...s.bannedWords],
    strictness: s.strictness,
    autoFix: s.autoFix,
  };
}

export function draftPut(d: SettingsDraft): BrandCheckSettingsPut {
  return {
    // Catalog order, so saving the same choice twice gives the same row.
    disabledChecks: checksByCategory()
      .flatMap((g) => g.checks)
      .filter((id) => d.disabled.has(id)),
    bannedWords: d.bannedWords,
    strictness: d.strictness,
    autoFix: d.autoFix,
  };
}

/** Words typed into the field ("bedava, garanti\nmucize") added to the list (no duplicates). */
export function addBannedWords(list: readonly string[], typed: string): string[] {
  const out = [...list];
  const seen = new Set(out.map((w) => w.toLocaleLowerCase("tr-TR")));
  for (const raw of typed.split(/[,\n;]+/)) {
    const word = raw.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!word) continue;
    const key = word.toLocaleLowerCase("tr-TR");
    if (seen.has(key) || out.length >= MAX_BANNED_WORDS) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/** Category toggle: all of its checks on, or all off. */
export function toggleCategory(
  disabled: ReadonlySet<CheckId>,
  checks: readonly CheckId[],
  on: boolean,
): Set<CheckId> {
  const next = new Set(disabled);
  for (const id of checks) {
    if (on) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** "AI" for the model pass, "Kural" for deterministic checks. */
export function sourceLabel(id: CheckId): string {
  const s = CHECK_CATALOG[id].source;
  return s === "model" ? "AI" : s === "both" ? "Kural + AI" : "Kural";
}
