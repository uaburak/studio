// Social account health in words (Ayarlar → Hesaplar, the connect results): the AppKit app's
// TokenHealthText. Pure; used by the main process (check results) and the renderer (table).
import type { SocialAccount } from "@studio/contract";

type AccountHealth = Pick<
  SocialAccount,
  "status" | "hasToken" | "tokenHealth" | "tokenExpiresAt" | "platform"
>;

const DAY = 86_400_000;

const HEALTH_LABELS: Record<string, string> = {
  valid: "Geçerli",
  expiring_soon: "Yakında doluyor",
  invalid: "Yeniden giriş gerekli",
  missing_scopes: "Eksik yetki",
};

export function platformName(platform: string): string {
  return (
    { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn" }[platform] ?? platform
  );
}

export function tokenHealthLabel(account: AccountHealth, now: Date = new Date()): string {
  if (account.status === "disabled") return "Bağlantı kesildi";
  if (account.hasToken === false) return "Bağlı değil";
  if (account.status === "needs_reauth") return "Yeniden bağlanmalı";
  const health = account.tokenHealth ?? "unchecked";
  let text = health === "unchecked" ? "Bağlı" : (HEALTH_LABELS[health] ?? "Bağlı");
  if (account.tokenExpiresAt) {
    const days = Math.ceil((Date.parse(account.tokenExpiresAt) - now.getTime()) / DAY);
    text += days > 0 ? ` · ${days} gün kaldı` : " · süresi doldu";
  }
  return text;
}

/** Orange only when the owner must act. */
export function tokenNeedsOwner(account: AccountHealth, now: Date = new Date()): boolean {
  if (account.status === "disabled") return false;
  if (account.status === "needs_reauth" || account.hasToken === false) return true;
  if (
    account.tokenHealth === "invalid" ||
    account.tokenHealth === "missing_scopes" ||
    account.tokenHealth === "expiring_soon"
  )
    return true;
  return account.tokenExpiresAt
    ? Date.parse(account.tokenExpiresAt) - now.getTime() < 7 * DAY
    : false;
}

export function tokenHint(account: AccountHealth): string | null {
  if (account.status === "needs_reauth" || account.tokenHealth === "invalid") {
    return "Erişim anahtarı geçersiz ya da süresi doldu; “Yeniden bağla” ile girişi yenileyin.";
  }
  if (account.tokenHealth === "missing_scopes") {
    return "Yayın için gereken izinlerden bazıları verilmemiş; yeniden bağlarken tüm izinleri onaylayın.";
  }
  if (account.tokenHealth === "expiring_soon") {
    return account.platform === "linkedin"
      ? "LinkedIn anahtarı 60 gün geçerlidir; bitmeden yeniden bağlayın."
      : "Erişim yakında doluyor; yeniden bağlayın.";
  }
  return null;
}
