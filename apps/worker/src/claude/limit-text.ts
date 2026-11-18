/**
 * What a job or a chat turn shows while Claude's usage window is used up (S7, U3): when it goes on
 * and, in "Sor" mode, that it waits for the owner's answer.
 */
import { formatClock } from "./errors.ts";
import type { ParkInfo } from "./gate.ts";

type ParkText = Pick<ParkInfo, "until" | "choice" | "canFallback">;

/** One line for the job's progress (and the chat's progress part). */
export function limitParkMessage(info: ParkText, now: Date = new Date()): string {
  const at = `saat ${formatClock(info.until, now)} civarında`;
  if (info.choice === "ask" && info.canFallback) {
    return `Claude sınırı doldu (${at} sıfırlanır). Seçiminiz bekleniyor: Ayarlar → Yapay zekâ'da "Gemini ile devam et" ya da "Sınırı bekle".`;
  }
  if (info.choice === "gemini" && !info.canFallback) {
    return `Claude sınırı doldu: ${at} devam edecek (bu iş Gemini'ye geçemiyor).`;
  }
  return `Claude sınırı doldu: ${at} devam edecek.`;
}
