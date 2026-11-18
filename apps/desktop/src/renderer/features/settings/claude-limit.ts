// Claude limit (S7): the "Claude sınırı dolunca" preference and the words for presence
// `claude.limit` in Ayarlar → Yapay zekâ. Pure, so the wording is tested.
import type { ClaudeLimitChoice, ClaudeLimitMode, ClaudeLimitState } from "@studio/contract";

export interface ClaudeLimitOption {
  value: ClaudeLimitMode;
  label: string;
  /** One plain line: what happens with this choice (follows "label: "). */
  hint: string;
}

/** The three choices, the default (`ask`) first. */
export const CLAUDE_LIMIT_OPTIONS: readonly ClaudeLimitOption[] = [
  { value: "ask", label: "Sor", hint: "iş durur, sana sorulur." },
  {
    value: "gemini",
    label: "Gemini'ye geç",
    hint: "Gemini ile sürer, notla gösterilir; ücretlidir.",
  },
  { value: "wait", label: "Bekle", hint: "sınır sıfırlanınca kendiliğinden devam eder." },
];

/** "Sor: iş durur, sana sorulur." one per line, for the row's detail. */
export function claudeLimitHints(): string[] {
  return CLAUDE_LIMIT_OPTIONS.map((o) => `${o.label}: ${o.hint}`);
}

function hm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const WEEKDAYS = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];

/** "saat 14:30 civarında" today, "Çar 14:30 civarında" on another day. */
export function resetTimeText(resetsAt: string, now: Date = new Date()): string {
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return "yakında";
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? `saat ${hm(date)} civarında`
    : `${WEEKDAYS[date.getDay()]} ${hm(date)} civarında`;
}

/** "Claude sınırı doldu · saat 14:30 civarında sıfırlanır · 3 iş bekliyor". */
export function claudeLimitLine(limit: ClaudeLimitState, now: Date = new Date()): string {
  const parts = ["Claude sınırı doldu", `${resetTimeText(limit.resetsAt, now)} sıfırlanır`];
  if (limit.waiting > 0) parts.push(`${limit.waiting} iş bekliyor`);
  return parts.join(" · ");
}

/**
 * What happens now: the owner's answer, else what the preference decides by itself (`gemini`
 * needs a Gemini key, otherwise it waits); null = `ask` with no answer yet (the work waits for
 * one). `answered`: an answer the app just sent that presence does not show yet.
 */
export function claudeLimitChoiceNow(
  limit: ClaudeLimitState,
  answered: ClaudeLimitChoice | null = null,
): ClaudeLimitChoice | null {
  if (limit.decision) return limit.decision;
  if (limit.mode === "gemini") return limit.geminiReady ? "gemini" : "wait";
  if (limit.mode === "wait") return "wait";
  return answered;
}

/** "Gemini ile sürüyor" / "Sınır bekleniyor". */
export function claudeLimitChoiceText(choice: ClaudeLimitChoice): string {
  return choice === "gemini" ? "Gemini ile sürüyor" : "Sınır bekleniyor";
}

/** The preference set to `gemini` without a Gemini key: it waits instead. */
export function claudeLimitModeWarning(mode: ClaudeLimitMode, geminiReady: boolean): string | null {
  return mode === "gemini" && !geminiReady ? "Gemini anahtarı yok: sınır dolunca beklenir." : null;
}
