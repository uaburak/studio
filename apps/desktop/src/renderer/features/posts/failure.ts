// Why a job failed, in plain Turkish (A3). The worker and the Hub report some failures in English
// ("render failed", "worker … lost the job"); the board, the jobs pane and the plan page show the
// reason in Turkish and keep the original for the tooltip.

const PATTERNS: { test: RegExp; text: string }[] = [
  { test: /lost the job|gave up after/i, text: "Mac'teki işçi işi yarıda bıraktı." },
  { test: /usage limit|rate.?limit|\b429\b|quota/i, text: "Yapay zekâ kullanım sınırına takıldı." },
  { test: /timed? ?out|timeout|deadline/i, text: "İş zamanında bitmedi." },
  {
    test: /render(ing)? failed|could not render|chromium|playwright/i,
    text: "Görsel oluşturulamadı.",
  },
  {
    test: /invalid json|unexpected token|did not match|schema|parse/i,
    text: "Yapay zekâ geçersiz bir yanıt verdi.",
  },
  { test: /ECONN|ENOTFOUND|network|fetch failed|socket hang up/i, text: "Bağlantı kurulamadı." },
  { test: /cancel/i, text: "İş durduruldu." },
  { test: /not found|\b404\b/i, text: "Gerekli kayıt bulunamadı (silinmiş olabilir)." },
];

/** Turkish letters or words: the message is already for the user. */
const TURKISH = /[çğıöşüÇĞİÖŞÜ]|\b(post|marka|görsel|yapay zekâ|sürüm|kontrol|hata|bulunamadı)\b/i;

export interface FailureText {
  /** What the user reads. */
  text: string;
  /** The original message (tooltip), when it differs. */
  detail: string | null;
}

/** "Üretilemedi" reason of a failed job. */
export function failureText(error: string | null | undefined): FailureText {
  const raw = (error ?? "").trim();
  if (!raw) return { text: "Neden bildirilmedi.", detail: null };
  if (TURKISH.test(raw)) return { text: raw, detail: null };
  const known = PATTERNS.find((p) => p.test.test(raw));
  return { text: known?.text ?? "İş başarısız oldu.", detail: raw };
}
